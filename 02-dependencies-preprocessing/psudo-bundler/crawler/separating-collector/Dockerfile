FROM python

WORKDIR /work

COPY requirements.txt requirements.txt

RUN pip install -r requirements.txt

COPY separating-collector.py separating-collector.py

CMD ["python", "separating-collector.py"]
