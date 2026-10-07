"""Свой гид программы передач: только каналы нашего плейлиста, из нескольких источников.

Основной источник (epg.one) берётся по tvg-id плейлиста. Каналу, у которого в нём программы
нет или она кончилась, программа подставляется из запасного источника по явной таблице
epg/sources.json — не угадыванием по названию: одно имя носят разные каналы (H2 в гидах — это
и армянский H2, и History 2). Из двух источников берётся тот, у которого программа на сейчас
есть и длиннее вперёд.

На выходе — XMLTV с id каналов, равными tvg-id плейлиста: приложения и вьювер берут его как
обычный гид. Окно — неделя назад (вся глубина записи) и всё, что есть вперёд.

  python3 tools/build_epg.py [папка-для-скачанного] [выходной.xml.gz]

Без зависимостей: стандартная библиотека Python 3.9+.
"""
import datetime as dt
import gzip
import json
import os
import re
import shutil
import subprocess
import sys
import urllib.request
import xml.etree.ElementTree as ET

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PLAYLIST = os.path.join(ROOT, "playlist", "def_tv.m3u")
CONFIG = json.load(open(os.path.join(ROOT, "epg", "sources.json"), encoding="utf-8"))
CACHE = sys.argv[1] if len(sys.argv) > 1 else os.path.join(ROOT, ".epg-cache")
OUT = sys.argv[2] if len(sys.argv) > 2 else os.path.join(ROOT, ".epg-cache", "epg.xml.gz")

NOW = dt.datetime.now(dt.timezone.utc)
BACK = NOW - dt.timedelta(hours=168)
# Основной источник годен, если программы на канал хватает хотя бы на столько вперёд
ENOUGH_AHEAD = dt.timedelta(hours=12)
MAX_DESC = 400


def playlist_channels():
    """tvg-id → название и логотип из плейлиста (каналы без tvg-id гида не получат)."""
    out = {}
    for line in open(PLAYLIST, encoding="utf-8-sig"):
        if not line.startswith("#EXTINF"):
            continue
        tvg = re.search(r'tvg-id="([^"]+)"', line)
        if not tvg:
            continue
        logo = re.search(r'tvg-logo="([^"]*)"', line)
        out.setdefault(tvg.group(1), {"name": line.rsplit(",", 1)[1].strip(), "logo": logo.group(1) if logo else ""})
    return out


def download(name, url):
    """Через curl, если он есть: сам ходит по редиректам и берёт системные сертификаты."""
    os.makedirs(CACHE, exist_ok=True)
    path = os.path.join(CACHE, f"{name}.xml.gz")
    agent = "Mozilla/5.0 (ElabTV EPG builder)"
    if shutil.which("curl"):
        subprocess.run(["curl", "-sSfL", "--retry", "3", "-m", "900", "-A", agent, "-o", path + ".part", url], check=True)
    else:
        req = urllib.request.Request(url, headers={"User-Agent": agent})
        with urllib.request.urlopen(req, timeout=900) as resp, open(path + ".part", "wb") as out:
            while chunk := resp.read(1 << 20):
                out.write(chunk)
    os.replace(path + ".part", path)
    return path


def parse_time(value):
    value = (value or "").strip()
    d = dt.datetime.strptime(value[:14].ljust(14, "0"), "%Y%m%d%H%M%S")
    zone = value[14:].strip() or "+0000"
    sign = 1 if zone[0] == "+" else -1
    return (d - sign * dt.timedelta(hours=int(zone[1:3]), minutes=int(zone[3:5]))).replace(tzinfo=dt.timezone.utc)


def read_guide(path, wanted):
    """Программа и иконки только нужных каналов: {id: {"icon": …, "programmes": [(start, stop, title, desc)]}}."""
    data = {cid: {"icon": "", "programmes": []} for cid in wanted}
    with gzip.open(path, "rb") as raw:
        for _, el in ET.iterparse(raw, events=("end",)):
            if el.tag == "programme":
                cid = el.get("channel")
                if cid in data:
                    try:
                        start, stop = parse_time(el.get("start")), parse_time(el.get("stop"))
                    except (ValueError, IndexError):
                        start = stop = None
                    if start and stop > start and stop >= BACK:
                        title = (el.findtext("title") or "").strip()
                        desc = (el.findtext("desc") or "").strip()[:MAX_DESC]
                        data[cid]["programmes"].append((start, stop, title, desc))
                el.clear()
            elif el.tag == "channel":
                cid = el.get("id")
                icon = el.find("icon")
                if cid in data and icon is not None and not data[cid]["icon"]:
                    data[cid]["icon"] = icon.get("src") or ""
                el.clear()
    for entry in data.values():
        entry["programmes"].sort()
    return data


def coverage(programmes):
    """(есть ли передача на сейчас, до какого момента программа)."""
    if not programmes:
        return False, BACK
    on_air = any(s <= NOW < e for s, e, _, _ in programmes)
    return on_air, max(e for _, e, _, _ in programmes)


def fmt(t):
    return t.strftime("%Y%m%d%H%M%S +0000")


def main():
    channels = playlist_channels()
    fallback = CONFIG["fallback"]
    wanted = {CONFIG["primary"]: set(channels)}
    for tvg, (src, sid) in fallback.items():
        wanted.setdefault(src, set()).add(sid)

    guides = {}
    for src, ids in wanted.items():
        print(f"{src}: качаю…", flush=True)
        guides[src] = read_guide(download(src, CONFIG["sources"][src]), ids)

    chosen = {}
    report = []
    for tvg in channels:
        primary = guides[CONFIG["primary"]].get(tvg, {"icon": "", "programmes": []})
        best, label = primary, CONFIG["primary"]
        on_air, until = coverage(primary["programmes"])
        if tvg in fallback and not (on_air and until >= NOW + ENOUGH_AHEAD):
            src, sid = fallback[tvg]
            alt = guides[src][sid]
            alt_on_air, alt_until = coverage(alt["programmes"])
            if (alt_on_air, alt_until) > (on_air, until):
                best, label = alt, f"{src}:{sid}"
                if not best["icon"]:
                    best["icon"] = primary["icon"]
        if best["programmes"]:
            chosen[tvg] = best
        report.append((channels[tvg]["name"], label, *coverage(best["programmes"])))

    tv = ET.Element("tv", {"generator-info-name": "ElabTV EPG (epg.one + запасные источники)"})
    for tvg, entry in chosen.items():
        ch = ET.SubElement(tv, "channel", {"id": tvg})
        ET.SubElement(ch, "display-name", {"lang": "ru"}).text = channels[tvg]["name"]
        icon = entry["icon"] or channels[tvg]["logo"]
        if icon:
            ET.SubElement(ch, "icon", {"src": icon})
    for tvg, entry in chosen.items():
        for start, stop, title, desc in entry["programmes"]:
            p = ET.SubElement(tv, "programme", {"start": fmt(start), "stop": fmt(stop), "channel": tvg})
            ET.SubElement(p, "title", {"lang": "ru"}).text = title or "Без названия"
            if desc:
                ET.SubElement(p, "desc", {"lang": "ru"}).text = desc

    os.makedirs(os.path.dirname(OUT) or ".", exist_ok=True)
    body = ET.tostring(tv, encoding="utf-8", xml_declaration=True)
    with open(OUT, "wb") as raw, gzip.GzipFile(fileobj=raw, mode="wb", mtime=0) as out:
        out.write(body)

    with_now = sum(1 for r in report if r[2])
    print(f"каналов в плейлисте с tvg-id: {len(channels)}, в гиде: {len(chosen)}, с передачей сейчас: {with_now}")
    print(f"размер: {os.path.getsize(OUT) / 1e6:.1f} МБ → {OUT}")
    for name, label, on_air, until in report:
        if label != CONFIG["primary"] or not on_air:
            print(f"  {name:28} {label:28} {'сейчас есть' if on_air else 'нет сейчас':12} до {until:%d.%m %H:%M}")


if __name__ == "__main__":
    main()
