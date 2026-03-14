#!/bin/bash
set -euo pipefail

# OpenBrain Local STT Setup
# Downloads sherpa-onnx binary and Parakeet TDT 0.6b model for local speech-to-text.
# Run once: bash setup-stt.sh

OPENBRAIN_HOME="${HOME}/.openbrain"
SHERPA_VERSION="1.10.39"
SHERPA_TARBALL="sherpa-onnx-v${SHERPA_VERSION}-osx-universal2-shared-no-tts.tar.bz2"
SHERPA_URL="https://github.com/k2-fsa/sherpa-onnx/releases/download/v${SHERPA_VERSION}/${SHERPA_TARBALL}"

MODEL_NAME="sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8"
MODEL_TARBALL="${MODEL_NAME}.tar.bz2"
MODEL_URL="https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/${MODEL_TARBALL}"
MODEL_DIR="${OPENBRAIN_HOME}/models/parakeet-tdt-0.6b-v2-int8"

echo "=== OpenBrain Local STT Setup ==="
echo "Install directory: ${OPENBRAIN_HOME}"
echo ""

# Create directories
mkdir -p "${OPENBRAIN_HOME}"/{bin,lib,models}

# --- Step 1: Download and install sherpa-onnx binary ---
if [ -f "${OPENBRAIN_HOME}/bin/sherpa-onnx-offline" ]; then
  echo "[OK] sherpa-onnx binary already installed"
else
  echo "[1/2] Downloading sherpa-onnx binary (~40MB)..."
  cd /tmp
  curl -L --progress-bar -o "${SHERPA_TARBALL}" "${SHERPA_URL}"

  echo "      Extracting..."
  EXTRACTED_DIR="sherpa-onnx-v${SHERPA_VERSION}-osx-universal2-shared-no-tts"
  tar xjf "${SHERPA_TARBALL}"

  cp "${EXTRACTED_DIR}/bin/sherpa-onnx-offline" "${OPENBRAIN_HOME}/bin/"
  cp "${EXTRACTED_DIR}"/lib/*.dylib "${OPENBRAIN_HOME}/lib/" 2>/dev/null || true
  chmod +x "${OPENBRAIN_HOME}/bin/sherpa-onnx-offline"

  # Cleanup
  rm -rf "${EXTRACTED_DIR}" "${SHERPA_TARBALL}"
  echo "[OK] sherpa-onnx binary installed"
fi

# --- Step 2: Download and install model ---
if [ -f "${MODEL_DIR}/encoder.int8.onnx" ]; then
  echo "[OK] Parakeet model already installed"
else
  echo "[2/2] Downloading Parakeet TDT 0.6b-v2 model (~622MB)..."
  echo "      This may take several minutes."
  cd /tmp
  curl -L --progress-bar -o "${MODEL_TARBALL}" "${MODEL_URL}"

  echo "      Extracting..."
  tar xjf "${MODEL_TARBALL}"

  mkdir -p "${MODEL_DIR}"
  cp "${MODEL_NAME}"/*.onnx "${MODEL_DIR}/" 2>/dev/null || true
  cp "${MODEL_NAME}"/tokens.txt "${MODEL_DIR}/" 2>/dev/null || true

  # Cleanup
  rm -rf "${MODEL_NAME}" "${MODEL_TARBALL}"
  echo "[OK] Parakeet model installed"
fi

echo ""
echo "=== Setup complete ==="
echo ""
echo "  Binary: ${OPENBRAIN_HOME}/bin/sherpa-onnx-offline"
echo "  Model:  ${MODEL_DIR}/"
echo ""
echo "  Enable in Obsidian: Settings > OpenBrain > Use local transcription"
echo ""
