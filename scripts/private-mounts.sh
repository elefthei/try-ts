#!/bin/sh
# Runs a command inside a private mount namespace whose nested mounts have been detached.
#
# `try` overlays each root-level directory (/usr, /var, /tmp, ...) separately, and the kernel
# refuses to clone a lowerdir that has locked child mounts. On hosts where something is mounted
# *inside* those directories -- WSL (/usr/lib/wsl/lib, /tmp/.X11-unix), docker (/var/lib/docker),
# systemd (/run/credentials/*) -- every such overlay fails and the sandbox ends up without /usr,
# i.e. without any binaries.
#
# This script re-execs itself under sudo in a fresh private mount namespace, lazily unmounts every
# nested mount there (the host's own mount table is untouched), drops back to the calling user, and
# runs the given command. Nothing in src/ needs it; it exists so the integration suite can run on
# such hosts.
#
#   scripts/private-mounts.sh bun test
set -eu

if [ "${TRY_TS_NS_INNER:-}" != "1" ]; then
    [ "$#" -gt 0 ] || { echo "usage: $0 CMD [ARG...]" >&2; exit 2; }
    exec sudo -E env \
        TRY_TS_NS_INNER=1 \
        TRY_TS_NS_UID="$(id -u)" TRY_TS_NS_GID="$(id -g)" TRY_TS_NS_PATH="$PATH" \
        unshare --mount --propagation private -- "$0" "$@"
fi

# Deepest first, so a parent is never unmounted before its children.
awk '{ print length($5), $5 }' /proc/self/mountinfo | sort -rn | cut -d' ' -f2- |
    while read -r mountpoint; do
        case "$mountpoint" in
            /dev | /dev/* | /proc | /proc/* | /) continue ;;
            /*/*) umount -l "$mountpoint" 2>/dev/null || true ;;
        esac
    done

PATH="$TRY_TS_NS_PATH"
export PATH
exec setpriv --reuid="$TRY_TS_NS_UID" --regid="$TRY_TS_NS_GID" --init-groups "$@"
