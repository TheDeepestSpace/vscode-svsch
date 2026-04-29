# Build UHDM
FROM public.ecr.aws/lts/ubuntu:22.04_stable AS uhdm-builder
ARG DEBIAN_FRONTEND=noninteractive
RUN apt update && apt install -y build-essential cmake ninja-build git python3 python3-pip
RUN pip3 install orderedmultidict
RUN git clone --recursive --branch v1.84 https://github.com/chipsalliance/UHDM.git /tmp/UHDM
RUN cd /tmp/UHDM && \
    mkdir build && cd build && \
    cmake .. -G Ninja -DCMAKE_BUILD_TYPE=Release -DCMAKE_INSTALL_PREFIX=/opt/uhdm && \
    ninja install

FROM public.ecr.aws/lts/ubuntu:22.04_stable

ARG DEBIAN_FRONTEND=noninteractive
ARG KEYRING_PATH=/usr/share/keyrings
ARG APT_SOURCES_PATH=/etc/apt/sources.list.d

# update and upgrade
RUN apt update && apt upgrade -y

# install essentialls
RUN apt update && \
    apt install -y \
    man make build-essential cmake ninja-build git zsh vim curl wget procps gnupg gnupg2 ca-certificates zip \
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

# install uhdm and surelog
USER root
RUN apt update && apt install -y python3-pip
USER dev
ARG SURELOG_VERSION=1.84.1
ARG SURELOG_WHL_NAME=sc_surelog-${SURELOG_VERSION}-cp310-cp310-manylinux_2_17_x86_64.manylinux2014_x86_64.whl
ARG SURELOG_WHL_URL=https://github.com/siliconcompiler/sc-surelog/releases/download/v${SURELOG_VERSION}/${SURELOG_WHL_NAME}
ARG SURELOG_WHL_HASH="fe7775681025cb90dcf16b5c176fcadc6c11212ed049c795ca3341168bf7d143  ${SURELOG_WHL_NAME}"
RUN cd /tmp && \
    wget ${SURELOG_WHL_URL} && \
    echo ${SURELOG_WHL_HASH} | sha256sum -c && \
    pip install ${SURELOG_WHL_NAME} uhdm==1.84 && \
    rm ${SURELOG_WHL_NAME}

# install uhdm from builder
COPY --from=uhdm-builder /opt/uhdm /usr/local

ENTRYPOINT ["/usr/bin/dumb-init", "--"]
