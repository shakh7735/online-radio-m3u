# online-radio-m3u

Публичный репозиторий-раздатчик: M3U-плейлисты, логотипы радиостанций и конфиг приложения
доступны по прямым `raw`-ссылкам без токена.

Инструмент, который всё это собирает (парсер top-radio.ru, локальный сервер и плеер),
живёт отдельно — в репозитории [html-viewer](https://github.com/shakh7735/html-viewer).

## Содержимое

| Папка | Что внутри |
| --- | --- |
| `playlist/` | плейлисты по умолчанию: `default.m3u` (радио), `def_tv.m3u` (ТВ) |
| `logos/` | логотипы радиостанций, на них ссылаются `tvg-logo` в плейлистах |
| `config/` | `elabhub.json` — конфиг ElabHub: резолверы YouTube и данные об обновлении |

## Ссылки

```
https://raw.githubusercontent.com/shakh7735/online-radio-m3u/main/playlist/default.m3u
https://raw.githubusercontent.com/shakh7735/online-radio-m3u/main/playlist/def_tv.m3u
https://raw.githubusercontent.com/shakh7735/online-radio-m3u/main/config/elabhub.json
```

Через CDN (кэш, но задержка обновления до 12 часов):

```
https://cdn.jsdelivr.net/gh/shakh7735/online-radio-m3u@main/playlist/default.m3u
```

Релизы APK ElabHub — во вкладке [Releases](https://github.com/shakh7735/online-radio-m3u/releases).

## Потоки ТВ и резервный узел

ТВ-каналы (`def_tv.m3u`) раздаёт CDN оператора; в плейлисте стоят два его входа:

| Узел | Каналов | Роль |
| --- | --- | --- |
| `ncdn-y1-vip2.teamcloud.am` | 170 | основной |
| `ncdn-fr-vip1.teamcloud.am` | 5 | используется для части каналов |
| `ncdn-y1-vip1.teamcloud.am` | — | **резервный**: отдаёт тот же контент |

Если основной узел начнёт сбоить, достаточно заменить хост в ссылках — путь остаётся тем же:

```
http://ncdn-y1-vip2.teamcloud.am/live/eds/<Канал>/SAF-HLS/<Канал>.m3u8
http://ncdn-y1-vip1.teamcloud.am/live/eds/<Канал>/SAF-HLS/<Канал>.m3u8   ← резерв
```

Имена каналов в пути регистрозависимы, а сам вход всегда отвечает редиректом на рабочую ноду
(`ncdn-y1-w9`, `-w12` и т. п.), так что запросы нужно делать с переходом по редиректам.
Несуществующий канал в итоге отдаёт 404 — по этому признаку удобно проверять живость.

Часть радиопотоков (`de.auroramedia.am`) закрыта от хотлинка и без заголовка `Referer`
отвечает 403 — он прописан в плейлисте директивой `#EXTVLCOPT:http-referrer`.

Программа передач берётся из `tvg-url` в шапке ТВ-плейлиста (`epg.one`); `tvg-id` проставлены
у 164 записей из 175. Оставшиеся 11 — локальные армянские каналы и 360TuneBox, которых нет ни
в одном доступном EPG.

## Лицензия и логотипы

Логотипы принадлежат самим радиостанциям и лежат здесь только для отображения в плейлистах.
