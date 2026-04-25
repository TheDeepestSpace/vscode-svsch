FROM public.ecr.aws/lts/ubuntu:22.04_stable

ARG DEBIAN_FRONTEND=noninteractive
ARG KEYRING_PATH=/usr/share/keyrings
ARG APT_SOURCES_PATH=/etc/apt/sources.list.d

# update and upgrade
RUN apt update && apt upgrade -y

# install essentialls
RUN apt update && \
    apt install -y \
    man make build-essential git zsh vim curl wget procps gnupg gnupg2 ca-certificates zip \
    software-properties-common

# unminimize the system
RUN bash -c "yes | unminimize"

# create dev sudo user
RUN useradd --create-home dev && \
    usermod --append --groups sudo dev && \
    apt update && apt install -y sudo && \
    echo '%sudo ALL=(ALL) NOPASSWD:ALL' >> /etc/sudoers

# install dumb init system
USER root
RUN apt update && apt install -y dumb-init

# setup oh-my-zsh
USER dev
ARG DOCKER_OHMYZSH_SCRIPT_NAME=zsh-in-docker.sh
ARG DOCKER_OHMYZSH_SCRIPT_URL=https://github.com/deluan/zsh-in-docker/releases/download/v1.1.3/${DOCKER_OHMYZSH_SCRIPT_NAME}
ARG DOCKER_OHMYZSH_SCRIPT_HASH="ffa8175332ef01b500ace59d03ce7e2f3a7453651e9a37060974bb6536f0706b  ${DOCKER_OHMYZSH_SCRIPT_NAME}"
RUN cd /tmp && \
    wget ${DOCKER_OHMYZSH_SCRIPT_URL} && \
    echo ${DOCKER_OHMYZSH_SCRIPT_HASH} | sha256sum -c && \
    chmod +x ./${DOCKER_OHMYZSH_SCRIPT_NAME} && \
    ./${DOCKER_OHMYZSH_SCRIPT_NAME} -t robbyrussell -p git -p ssh-agent && \
    rm ./${DOCKER_OHMYZSH_SCRIPT_NAME}

# install node (TODO: only x86 for now, add arm64 version)
USER dev
ARG NODE_VERSION=24.15.0
ARG NODE_STANDALONE_NAME=node-v${NODE_VERSION}-linux-x64.tar.xz
ARG NODE_STANDALONE_HASH="472655581fb851559730c48763e0c9d3bc25975c59d518003fc0849d3e4ba0f6  ${NODE_STANDALONE_NAME}"
ARG NODE_STANDALONE_URL=https://nodejs.org/dist/v24.15.0/${NODE_STANDALONE_NAME}
RUN cd /tmp && \
    wget ${NODE_STANDALONE_URL} && \
    echo ${NODE_STANDALONE_HASH} | sha256sum -c && \
    sudo tar -xJf ${NODE_STANDALONE_NAME} -C /usr/local --strip-components=1 --no-same-owner && \
    rm ${NODE_STANDALONE_NAME}

# install verible (TODO: only x86 for now, add arm64 version)
USER dev
ARG VERIBLE_VERSION=v0.0-4053-g89d4d98a
ARG VERIBLE_BIN_NAME=verible-${VERIBLE_VERSION}-linux-static-x86_64.tar.gz
ARG VERIBLE_BIN_URL=https://github.com/chipsalliance/verible/releases/download/${VERIBLE_VERSION}/${VERIBLE_BIN_NAME}
ARG VERIBLE_BIN_HASH="1edc1f29c70d74213ed373e727183802d5a733e23f9ab9c74462f5b18b76f2c0  ${VERIBLE_BIN_NAME}"
RUN cd /tmp && \
    wget ${VERIBLE_BIN_URL} && \
    echo ${VERIBLE_BIN_HASH} | sha256sum -c && \
    sudo tar -xf ${VERIBLE_BIN_NAME} -C /usr/local --strip-components=1 --no-same-owner && \
    rm ${VERIBLE_BIN_NAME}

ENTRYPOINT ["/usr/bin/dumb-init", "--"]
