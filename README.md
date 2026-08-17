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

## Лицензия и логотипы

Логотипы принадлежат самим радиостанциям и лежат здесь только для отображения в плейлистах.
