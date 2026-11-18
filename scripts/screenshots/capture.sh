#!/bin/bash
D=$1; USERPIDS=$(pgrep -f "/Applications/Visual Studio Code.app/Contents/MacOS" | tr '\n' ' ')
for s in completion menu nextedit backends; do
  for i in $(seq 1 900); do [ -f $D/sig/$s.ready ] && break; sleep 0.2; done
  [ -f $D/sig/$s.ready ] || { echo "timeout $s"; exit 1; }
  sleep 0.5
  W=$($D/win $USERPIDS)
  screencapture -x -o -l $W $D/shots/$s.png && echo "captured $s (window $W)" || echo "capture failed $s"
  touch $D/sig/$s.done
done
