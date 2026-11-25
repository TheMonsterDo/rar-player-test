# rar-player-test

Synthetic test archives for a browser RAR stream player (reads video inside store-mode `.rar` files with HTTP Range requests).

All content is generated locally with ffmpeg: a `testsrc2` test pattern and a 440 Hz sine tone, 20 s, 1280x720. No third-party material.

**Player:** https://themonsterdo.github.io/rar-player-test/ — add `?url=` with a direct link to a store-mode `.rar` (host must allow CORS + Range), e.g. https://themonsterdo.github.io/rar-player-test/?url=https://raw.githubusercontent.com/TheMonsterDo/rar-player-test/main/single.rar

| File | What it tests |
|---|---|
| `single.rar` | mp4 in one store-mode (-m0) archive |
| `multi.part1.rar` … `part4.rar` | same mp4 split into 2 MB volumes |
| `mkv.rar` | same clip in an MKV container |
| `pass.rar` | password-protected (`test123`), should be refused |

Served raw via `raw.githubusercontent.com`, which sends `Access-Control-Allow-Origin: *` and supports Range.
