#!/bin/bash
# Installed on the Pi as /home/umbrel/umbrel/custom-hooks/pre-start (root-owned, mode 755).
# umbrelOS runs it as root at every boot, before umbreld starts (umbrel-custom-pre-start.service).
#
# Why: since the 2026-11 umbrelOS update the root filesystem is rebuilt on every boot, so
# `usermod -aG docker umbrel` is lost on reboot, and the Mac's Docker context (ssh://umbrel-docker,
# user umbrel) fails with "permission denied" on /var/run/docker.sock. Only the data partition
# (this folder) survives. Must stay root-owned: a hook the umbrel user could edit would be root access.
set -u

id -nG umbrel | tr ' ' '\n' | grep -qx docker || usermod -aG docker umbrel
