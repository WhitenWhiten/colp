# Match packages/extension/package-lock.json; update and verify both together.
FROM mcr.microsoft.com/playwright:v1.61.1-noble@sha256:5b8f294aff9041b7191c34a4bab3ac270157a28774d4b0660e9743297b697e48
RUN apt-get update \
    && apt-get install --yes --no-install-recommends xdotool \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /workspace/packages/extension
