"""Гиды для внешних плейлистов: на каждый плейлист из epg/external.json — свой XMLTV.

Внешние плейлисты (провайдерские) идут без tvg-id, и приложение связывает их с гидом только по
названию. Полный гид источника на это не рассчитан: одно имя носят разные каналы, у части
каналов программы нет, а для «+2» нашёлся бы московский эфир. Здесь каналу подбирается
программа из всех источников epg/sources.json, а на выходе id и название канала — ровно те, что
в плейлисте, так что приложение находит его без угадывания.

Как подбирается программа (по порядку):
  1. Явная строка в map плейлиста: [источник, id] или [источник, id, сдвиг в часах]; null —
     оставить канал без программы.
  2. Каналы источников с тем же названием — по тем же правилам, что и в приложении (регистр,
     пробелы и пометки качества не важны). «+N» в названии должен совпасть: «НТВ +2» не получит
     московский НТВ, а «НТВ» — сетку «НТВ (+2)».
  3. Для «+N», которого нет ни в одном источнике, — программа основного канала со сдвигом на N
     часов.
Из нескольких подходящих берётся тот, у кого передача на сейчас есть и программа длиннее вперёд;
при равенстве — основной источник.

Адрес плейлиста — в секрете Actions (переменная окружения из поля env): в нём ключ провайдера,
а репозиторий публичный. Переменной нет — плейлист пропускается. Для проверки на своём
компьютере в переменную можно положить путь к файлу.

  python3 tools/build_epg_external.py [папка-для-скачанного] [папка-для-гидов]

Рядом с гидом пишется <имя>.txt — какой канал откуда получил программу и кому её не нашлось.
"""
import datetime as dt
import gzip
import json
import os
import re
import sys
import urllib.request
import xml.etree.ElementTree as ET

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from build_epg import BACK, CACHE, CONFIG, ENOUGH_AHEAD, MAX_DESC, NOW, ROOT, coverage, download, fmt, parse_time  # noqa: E402

EXTERNAL = json.load(open(os.path.join(ROOT, "epg", "external.json"), encoding="utf-8"))
OUT_DIR = sys.argv[2] if len(sys.argv) > 2 else os.path.join(CACHE, "ext")
# Описания у прошедших передач — только за последние сутки. Внешние плейлисты — это тысячи
# каналов, и неделя назад (глубина записи) с описаниями — триста мегабайт XML, которые приставке
# разбирать; в записи же неделю назад смотрят по названиям
DESC_SINCE = NOW - dt.timedelta(hours=24)
# Скачанный в этом же прогоне гид (build_epg.py идёт первым) второй раз не качаем
REUSE_AGE = dt.timedelta(hours=3)

QUALITY = ("hevc", "uhd", "fhd", "hdr", "hd", "sd", "4k", "orig")
# «+N» отдельным словом: «НТВ +2», «НТВ (+2)», но не «1+1»
SHIFT = re.compile(r"(?:^|\s)\(?\+\s*(\d{1,2})\s*\)?(?=\s|$)")


def norm(name):
    """Как normalizeChannelName в ElabTvCore, плюс пометка HDR («BCU Action HDR» = «BCU Action HD»)."""
    words = [w for w in re.split(r"[^\w]+|_", name.lower().replace("ё", "е")) if w]
    letters = "".join(w for w in words if w not in QUALITY) or "".join(words)
    for mark in QUALITY:
        if len(letters) > len(mark) and letters.endswith(mark):
            return letters[: -len(mark)]
    return letters


def shift_of(name):
    """Сдвиг эфира из названия: «Пятница! +4» → 4, «НТВ +0 (Тамбов)» → 0, без сдвига — None."""
    m = SHIFT.search(name)
    return int(m.group(1)) if m else None


def has_plus(name):
    """«+» без цифры — часть названия: «ETV+», «Setanta Sports+» — другие каналы, не «ETV»."""
    return bool(re.search(r"\+(?!\s*\d)", name))


def without_city(name):
    """«НТВ +4 (Алтай)» → «НТВ +4»: город в скобках есть у региональных вставок, в гидах — редко."""
    return re.sub(r"\s*\([^)]*\)\s*$", "", name)


def base_name(name):
    return SHIFT.sub(" ", without_city(name)).strip()


def read_playlist(location):
    if re.match(r"https?://", location):
        req = urllib.request.Request(location, headers={"User-Agent": "Mozilla/5.0 (ElabTV EPG builder)"})
        with urllib.request.urlopen(req, timeout=120) as resp:
            text = resp.read().decode("utf-8-sig", "replace")
    else:
        text = open(location, encoding="utf-8-sig").read()
    names = []
    for line in text.splitlines():
        if line.startswith("#EXTINF"):
            # Название — после запятой, что закрывает атрибуты: в самих названиях запятые бывают
            name = re.sub(r'^#EXTINF:[^,"]*(?:"[^"]*"[^,"]*)*,', "", line).strip()
            if name and name not in names:
                names.append(name)
    return names


def cached(src):
    path = os.path.join(CACHE, f"{src}.xml.gz")
    if os.path.exists(path):
        age = dt.datetime.now() - dt.datetime.fromtimestamp(os.path.getmtime(path))
        if age < REUSE_AGE:
            return path
    return download(src, CONFIG["sources"][src])


def read_source(path, wanted_names, wanted_ids):
    """Названия всех каналов источника и программа тех, что подходят по названию или названы явно.

    Блоки <channel> в XMLTV идут раньше передач, поэтому нужные id известны к первой передаче.
    """
    channels = {}  # id → {"names": [...], "icon": ...}
    programmes = {}
    keep = None
    with gzip.open(path, "rb") as raw:
        for _, el in ET.iterparse(raw, events=("end",)):
            if el.tag == "channel":
                icon = el.find("icon")
                channels[el.get("id")] = {
                    "names": [(n.text or "").strip() for n in el.findall("display-name") if (n.text or "").strip()],
                    "icon": icon.get("src") if icon is not None else "",
                }
                el.clear()
            elif el.tag == "programme":
                if keep is None:
                    keep = {cid for cid, ch in channels.items()
                            if cid in wanted_ids or any(norm(n) in wanted_names for n in ch["names"])}
                cid = el.get("channel")
                if cid in keep:
                    try:
                        start, stop = parse_time(el.get("start")), parse_time(el.get("stop"))
                    except (ValueError, IndexError, TypeError):
                        start = stop = None
                    if start and stop > start and stop >= BACK:
                        title = (el.findtext("title") or "").strip()
                        desc = (el.findtext("desc") or "").strip()[:MAX_DESC]
                        programmes.setdefault(cid, []).append((start, stop, title, desc))
                el.clear()
    for items in programmes.values():
        items.sort()
    return channels, programmes


def rank(programmes, src, main):
    """Чем больше, тем лучше. Основной источник с передачей на сейчас и запасом вперёд выигрывает
    сразу — как в build_epg.py: запасной по одному названию может оказаться другим каналом
    («Звезда» в iptvx — псевдоним «Звезды Плюс»). Дальше — совпало ли главное название канала,
    а не псевдоним, и чья программа длиннее."""
    on_air, until = coverage(programmes)
    primary = src == CONFIG["primary"]
    return (primary and on_air and until >= NOW + ENOUGH_AHEAD, on_air, main, until, len(programmes), primary)


def shifted(programmes, hours):
    delta = dt.timedelta(hours=hours)
    return [(s + delta, e + delta, t, d) for s, e, t, d in programmes]


def same_channel(playlist_name, guide_name):
    """Название из гида подходит каналу плейлиста: та же нормализация, тот же сдвиг и «+»."""
    return (norm(guide_name) == norm(playlist_name)
            and (shift_of(guide_name) or 0) == (shift_of(playlist_name) or 0)
            and has_plus(guide_name) == has_plus(playlist_name))


def pick(name, sources):
    """(программа, иконка, откуда) для канала плейлиста; программы нет — (None, "", причина)."""
    best = None
    for src, (channels, programmes) in sources.items():
        for cid, ch in channels.items():
            if cid not in programmes:
                continue
            names = ch["names"]
            hits = [n for n in names if same_channel(name, n)]
            if not hits:
                continue
            r = rank(programmes[cid], src, hits[0] == names[0])
            if best is None or r > best[0]:
                best = (r, programmes[cid], ch["icon"], f"{src}:{cid} {names[0]}")
    if best is not None:
        return best[1], best[2], best[3]
    # «НТВ +4 (Алтай)» → «НТВ +4» → «НТВ» на 4 часа позже; «+0 (Тамбов)» — эфир московский
    if without_city(name) != name:
        found = pick(without_city(name), sources)
        if found[0]:
            return found
    hours = shift_of(name)
    if hours is not None and base_name(name) != name:
        base = pick(base_name(name), sources)
        if base[0]:
            label = f"{base[2]} со сдвигом +{hours} ч" if hours else f"{base[2]} (+0)"
            return shifted(base[0], hours), base[1], label
    return None, "", "нет в источниках"


def build(key, spec):
    location = os.environ.get(spec["env"], "").strip()
    if not location:
        print(f"{key}: переменной {spec['env']} нет — пропускаю")
        return
    names = read_playlist(location)
    overrides = spec.get("map", {})
    wanted_names = set()
    for name in names:
        wanted_names.add(norm(name))
        wanted_names.add(norm(without_city(name)))
        wanted_names.add(norm(base_name(name)))
    wanted_ids = {}
    for target in overrides.values():
        if target:
            wanted_ids.setdefault(target[0], set()).add(target[1])

    sources = {}
    for src in CONFIG["sources"]:
        print(f"{key}: {src}…", flush=True)
        sources[src] = read_source(cached(src), wanted_names, wanted_ids.get(src, set()))

    chosen, report = {}, []
    for name in names:
        if name in overrides:
            target = overrides[name]
            if target is None:
                report.append((name, "выключено в map", None))
                continue
            src, cid = target[0], target[1]
            channels, programmes = sources[src]
            items = programmes.get(cid, [])
            if len(target) > 2:
                items = shifted(items, target[2])
            entry = (items or None, channels.get(cid, {}).get("icon", ""), f"map {src}:{cid}")
        else:
            entry = pick(name, sources)
        if entry[0]:
            chosen[name] = entry
        report.append((name, entry[2], entry[0]))

    tv = ET.Element("tv", {"generator-info-name": "ElabTV EPG (внешний плейлист)"})
    for name, (_, icon, _) in chosen.items():
        ch = ET.SubElement(tv, "channel", {"id": name})
        ET.SubElement(ch, "display-name", {"lang": "ru"}).text = name
        if icon:
            ET.SubElement(ch, "icon", {"src": icon})
    for name, (items, _, _) in chosen.items():
        for start, stop, title, desc in items:
            p = ET.SubElement(tv, "programme", {"start": fmt(start), "stop": fmt(stop), "channel": name})
            ET.SubElement(p, "title", {"lang": "ru"}).text = title or "Без названия"
            if desc and stop >= DESC_SINCE:
                ET.SubElement(p, "desc", {"lang": "ru"}).text = desc

    os.makedirs(OUT_DIR, exist_ok=True)
    out = os.path.join(OUT_DIR, f"{key}.xml.gz")
    body = ET.tostring(tv, encoding="utf-8", xml_declaration=True)
    with open(out, "wb") as raw, gzip.GzipFile(fileobj=raw, mode="wb", mtime=0) as gz:
        gz.write(body)

    lines = []
    with_now = short = 0
    for name, label, items in report:
        on_air, until = coverage(items or [])
        with_now += on_air
        if items and on_air and until < NOW + ENOUGH_AHEAD:
            short += 1
        state = "нет программы" if not items else ("сейчас есть" if on_air else "сейчас дыра")
        lines.append(f"{name}\t{state}\t{until:%d.%m %H:%M}\t{label}" if items else f"{name}\t{state}\t\t{label}")
    summary = (f"{key}: каналов {len(names)}, с программой {len(chosen)}, с передачей сейчас {with_now}, "
               f"программы меньше {ENOUGH_AHEAD.seconds // 3600} ч вперёд {short}; "
               f"{os.path.getsize(out) / 1e6:.1f} МБ")
    with open(os.path.join(OUT_DIR, f"{key}.txt"), "w", encoding="utf-8") as f:
        f.write(f"# {summary}\n# собрано {NOW:%Y-%m-%d %H:%M} UTC\n" + "\n".join(lines) + "\n")
    print(summary)


def main():
    for key, spec in EXTERNAL["playlists"].items():
        build(key, spec)


if __name__ == "__main__":
    main()
