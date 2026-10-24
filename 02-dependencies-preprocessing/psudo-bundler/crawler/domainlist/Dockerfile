FROM python

ARG LIST_ID

WORKDIR /work

RUN env && \
    echo https://tranco-list.eu/download/${LIST_ID}/1000000 && \
    test -n "${LIST_ID}" && \
    curl -o domainlist.csv https://tranco-list.eu/download/${LIST_ID}/1000000

COPY requirements.txt requirements.txt

RUN pip install -r requirements.txt

COPY domainlist.py domainlist.py

CMD ["python", "domainlist.py"]
