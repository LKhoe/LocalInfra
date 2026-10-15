# The official image is FROM scratch (just the static binary): no shell for the marker check
# in start.sh and no wget for the healthcheck. Copy the binary onto Alpine instead.
ARG GARAGE_VERSION=v2.4.1
FROM dxflrs/garage:${GARAGE_VERSION} AS garage

FROM alpine:3.22

COPY --from=garage /garage /usr/local/bin/garage
COPY garage.toml /etc/garage.toml
COPY start.sh /usr/local/bin/localinfra-s3-start
RUN chmod 755 /usr/local/bin/localinfra-s3-start

ENTRYPOINT ["localinfra-s3-start"]
CMD []
