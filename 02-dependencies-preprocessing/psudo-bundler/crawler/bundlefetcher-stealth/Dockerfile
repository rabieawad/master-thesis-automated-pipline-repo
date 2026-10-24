FROM python
WORKDIR /work

RUN apt-get update && \
    apt-get install -y nodejs npm wget gnupg ca-certificates apt-transport-https xvfb psmisc && \
    rm -rf /var/lib/apt/lists/* && \
    useradd pptr && \
    mkdir -p /home/pptr && \
    chown pptr:pptr /home/pptr && \
    chown pptr /work

RUN wget -q -O - https://dl-ssl.google.com/linux/linux_signing_key.pub | apt-key add - \
    && echo "deb [arch=amd64] https://dl.google.com/linux/chrome/deb/ stable main" >> /etc/apt/sources.list.d/google.list \
    && apt-get update \
    && apt-get install -y google-chrome-stable \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt requirements.txt

RUN pip install -r requirements.txt

USER pptr

RUN npm i puppeteer-real-browser express

COPY puppeteer.mjs puppeteer.mjs

COPY bundlefetcher-stealth.py bundlefetcher-stealth.py

ENV MAX_PARALLEL_COUNTER=30

CMD ["sh", "-c", "(while true; do node puppeteer.mjs; done) & python bundlefetcher-stealth.py"]
