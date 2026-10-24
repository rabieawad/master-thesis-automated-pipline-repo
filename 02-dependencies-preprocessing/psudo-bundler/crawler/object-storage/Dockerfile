FROM python

WORKDIR /work

COPY requirements.txt requirements.txt

RUN pip install -r requirements.txt

COPY object-storage.py object-storage.py

CMD ["python", "object-storage.py"]
