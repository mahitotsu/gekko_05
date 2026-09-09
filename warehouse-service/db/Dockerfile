FROM redis:7-alpine
COPY seed.sh /usr/local/bin/seed.sh
RUN chmod +x /usr/local/bin/seed.sh
ENTRYPOINT ["/usr/local/bin/seed.sh"]
