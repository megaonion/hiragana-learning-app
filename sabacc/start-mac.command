#!/bin/bash
cd "$(dirname "$0")"
if ! command -v node > /dev/null 2>&1; then
  echo "Node.js가 설치되어 있지 않습니다. https://nodejs.org 에서 LTS 버전을 설치한 뒤 다시 실행하세요."
  read -n 1 -s -r -p "아무 키나 누르면 닫힙니다."
  exit 1
fi
if [ ! -d node_modules ]; then
  echo "처음 실행: 필요한 파일을 설치합니다..."
  npm install --omit=dev
fi
(sleep 1 && open "http://localhost:3000") &
node server.js
