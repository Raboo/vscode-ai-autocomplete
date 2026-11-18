# Screenshots

Regenerates the images in `images/` from a test copy of VS Code and a mock model server (no real model needed). macOS only; the terminal needs Screen Recording permission.

```bash
npm run build
D=/tmp/aac-demo   # short path: VS Code's IPC socket path must stay under 103 characters
rm -rf $D && mkdir -p $D/ws $D/user/User $D/sig $D/shots $D/ext
cp scripts/screenshots/workspace/* $D/ws/ && cp scripts/screenshots/user/settings.json $D/user/User/
cp scripts/screenshots/*.js scripts/screenshots/capture.sh $D/ && chmod +x $D/capture.sh
swiftc -O -o $D/win scripts/screenshots/win.swift && swiftc -O -o $D/crop scripts/screenshots/crop.swift
($D/capture.sh $D &) ; DEMO_DIR=$D node $D/launch.js
```

`run.js` plays four scenes (completion, status bar menu, Next Edit, Backends page) and waits at each until `capture.sh` has taken the window. Then crop and scale, for example `$D/crop $D/shots/completion.png /tmp/c.png 0 0 2880 1000 && sips --resampleWidth 1440 /tmp/c.png --out images/completion.png`.
