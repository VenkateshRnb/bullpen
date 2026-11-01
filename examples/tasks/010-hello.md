---
kind: docs
check:
  - node -e "process.exit(require('fs').readFileSync('hello.txt','utf8').trim()==='hello from bullpen'?0:1)"
---
Create a file named `hello.txt` in the repository root containing exactly this text on a single line:

hello from bullpen
