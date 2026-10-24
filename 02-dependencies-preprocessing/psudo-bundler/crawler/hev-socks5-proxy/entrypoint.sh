#!/usr/bin/env sh
sed -i 's/__PORT__/'"$PORT"'/g' /hev.yml
sed -i 's/__BIND_ADDRESS__/'"$BIND_ADDRESS"'/g' /hev.yml

exec $@