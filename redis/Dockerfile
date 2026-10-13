ARG REDIS_VERSION=7.4
FROM redis:${REDIS_VERSION}-alpine

COPY start.sh /usr/local/bin/localinfra-redis-start
RUN chmod 755 /usr/local/bin/localinfra-redis-start

ENTRYPOINT ["localinfra-redis-start"]
CMD []
