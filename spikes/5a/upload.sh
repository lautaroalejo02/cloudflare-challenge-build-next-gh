#!/usr/bin/env bash
set -u
BASE="https://registry.cloudflare.com"
REPO="f3adabb2e83104cf7b9c244077547991/spike-5a-spike5asandbox"
DIR="tmp/img"
CHUNK=$((8*1024*1024))
CRED=$(cat .secret-basic)
HDRS=tmp/.hdrs

BLOBS=$(node -e "const m=require('./$DIR/manifest.json')[0]; console.log([...new Set([m.Config,...m.Layers])].join(' '))")

for b in $BLOBS; do
  digest=${b##*/}
  file="$DIR/$b"
  code=$(curl -s -o /dev/null -w "%{http_code}" -I -H "Authorization: Basic $CRED" "$BASE/v2/$REPO/blobs/sha256:$digest")
  if [ "$code" = "200" ]; then echo "exists ${digest:0:12}"; continue; fi
  size=$(stat -c%s "$file")
  echo "uploading ${digest:0:12} ($size bytes)"
  loc=$(curl -s -D - -o /dev/null -X POST -H "Authorization: Basic $CRED" "$BASE/v2/$REPO/blobs/uploads/" | tr -d '\r' | awk 'tolower($1)=="location:"{print $2}')
  loc="$BASE$loc"
  off=0
  tries=0
  while [ $off -lt $size ]; do
    end=$(( off+CHUNK-1 )); [ $end -ge $size ] && end=$(( size-1 ))
    len=$(( end-off+1 ))
    tail -c +$((off+1)) "$file" | head -c $len > tmp/chunk.bin
    code=$(curl -s -o /dev/null -D "$HDRS" -w "%{http_code}" -X PATCH \
      -H "Authorization: Basic $CRED" -H "Content-Type: application/octet-stream" \
      -H "Content-Range: $off-$end" --data-binary @tmp/chunk.bin "$loc")
    if [ "$code" = "202" ]; then
      newloc=$(tr -d '\r' < "$HDRS" | awk 'tolower($1)=="location:"{print $2}')
      loc="$BASE$newloc"
      off=$((end+1)); tries=0
      printf "\r  %d/%d" $off $size
    else
      tries=$((tries+1)); [ $tries -gt 30 ] && { echo " BLOB FAILED"; exit 1; }
      # get committed offset
      curl -s -D "$HDRS" -o /dev/null -H "Authorization: Basic $CRED" "$loc"
      rng=$(tr -d '\r' < "$HDRS" | awk 'tolower($1)=="range:"{print $2}')
      newoff=$(echo "$rng" | sed -E 's/.*-([0-9]+)/\1/'); newoff=$(( ${newoff:-0} + 1 ))
      [ $newoff -gt $off ] && off=$newoff
      printf " [retry code=%s off=%d]" "$code" $off
      sleep 1
    fi
  done
  sep="?"; [[ "$loc" == *"?"* ]] && sep="&"
  code=$(curl -s -o /dev/null -w "%{http_code}" -X PUT -H "Authorization: Basic $CRED" "${loc}${sep}digest=sha256:$digest")
  echo " -> PUT $code"
  [ "$code" != "201" ] && { echo "FINALIZE FAILED"; exit 1; }
done
echo DONE
