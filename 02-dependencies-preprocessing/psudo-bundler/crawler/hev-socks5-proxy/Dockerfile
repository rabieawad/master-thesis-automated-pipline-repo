FROM alpine

RUN apk add sed curl && \
    curl -L -o /hev-socks5-server "https://github.com/heiher/hev-socks5-server/releases/download/2.6.8/hev-socks5-server-linux-x86_64" && \
    chmod +x /hev-socks5-server

COPY entrypoint.sh /entrypoint.sh
COPY hev.yml /hev.yml

ENTRYPOINT ["/entrypoint.sh"]
CMD ["/hev-socks5-server", "/hev.yml"]
