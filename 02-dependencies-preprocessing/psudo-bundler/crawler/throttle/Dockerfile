FROM python

WORKDIR /work

COPY requirements.txt requirements.txt

RUN pip install -r requirements.txt

COPY throttle.py throttle.py

CMD ["python", "throttle.py"]
