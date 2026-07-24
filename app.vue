<script setup lang="ts">
import {
  Camera,
  CheckCircle2,
  ClipboardList,
  FileSpreadsheet,
  Loader2,
  Pause,
  Play,
  Search,
  ShieldCheck,
  Trash2,
  XCircle,
  ZoomIn
} from '@lucide/vue'

type ScanStatus = 'found' | 'missing'
type CameraPermissionState = 'unknown' | 'prompt' | 'granted' | 'denied'

interface ScanRecord {
  code: string
  status: ScanStatus
  time: string
}

interface ScannerControls {
  stop: () => void
  switchTorch?: (onOff: boolean) => Promise<void>
  streamVideoConstraintsApply?: (
    constraints: MediaTrackConstraints,
    trackFilter?: (track: MediaStreamTrack) => MediaStreamTrack[]
  ) => void
  streamVideoCapabilitiesGet?: (
    trackFilter: (track: MediaStreamTrack) => MediaStreamTrack[]
  ) => MediaTrackCapabilities
}

const STORAGE_KEY = 'barkodokuma:list'
const HISTORY_KEY = 'barkodokuma:history'

const barcodeListText = ref('')
const manualCode = ref('')
const lastCode = ref('')
const cameraError = ref('')
const scannerMessage = ref('Kamera hazır')
const cameraPermission = ref<CameraPermissionState>('unknown')
const importMessage = ref('')
const isImporting = ref(false)
const isScanning = ref(false)
const isTorchOn = ref(false)
const isTorchSupported = ref(false)
const isZoomSupported = ref(false)
const zoomValue = ref(1)
const zoomMin = ref(1)
const zoomMax = ref(1)
const zoomStep = ref(0.1)
const fileInputRef = ref<HTMLInputElement | null>(null)
const videoRef = ref<HTMLVideoElement | null>(null)
const controlsRef = shallowRef<ScannerControls | null>(null)
const history = ref<ScanRecord[]>([])
const lastDetectedAt = ref(0)

const normalizedCodes = computed(() => parseCodes(barcodeListText.value))
const knownCodes = computed(() => new Set(normalizedCodes.value))
const totalCodes = computed(() => normalizedCodes.value.length)
const foundCount = computed(
  () => history.value.filter((item) => item.status === 'found').length
)
const missingCount = computed(
  () => history.value.filter((item) => item.status === 'missing').length
)
const lastStatus = computed<ScanStatus | null>(() => {
  const code = normalizeCode(lastCode.value)

  if (!code) {
    return null
  }

  return knownCodes.value.has(code) ? 'found' : 'missing'
})

const sampleList = `8690632030014
5449000000996
3017620422003
1234567890128`

watch(barcodeListText, (value) => {
  if (import.meta.client) {
    localStorage.setItem(STORAGE_KEY, value)
  }
})

watch(
  history,
  (value) => {
    if (import.meta.client) {
      localStorage.setItem(HISTORY_KEY, JSON.stringify(value))
    }
  },
  { deep: true }
)

onMounted(() => {
  barcodeListText.value = localStorage.getItem(STORAGE_KEY) || sampleList

  try {
    history.value = JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]')
  } catch {
    history.value = []
  }

  refreshCameraPermission()
})

onBeforeUnmount(() => {
  stopScanner()
})

function parseCodes(value: string) {
  const unique = new Set<string>()

  value
    .split(/[\n,;\t ]+/)
    .map(normalizeCode)
    .filter(Boolean)
    .forEach((code) => unique.add(code))

  return [...unique]
}

function normalizeCode(value: unknown) {
  return String(value ?? '')
    .trim()
    .replace(/\.0$/, '')
    .replace(/\s+/g, '')
    .toUpperCase()
}

function isLikelyBarcode(value: unknown) {
  const code = normalizeCode(value)

  return /^[A-Z0-9-]{4,64}$/.test(code) && /\d/.test(code)
}

function checkCode(rawCode: string) {
  const code = normalizeCode(rawCode)

  if (!code) {
    return
  }

  lastCode.value = code
  manualCode.value = ''

  const status: ScanStatus = knownCodes.value.has(code) ? 'found' : 'missing'
  const record: ScanRecord = {
    code,
    status,
    time: new Intl.DateTimeFormat('tr-TR', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    }).format(new Date())
  }

  history.value = [
    record,
    ...history.value.filter((item) => item.code !== code)
  ].slice(0, 30)
}

function loadSampleList() {
  barcodeListText.value = sampleList
  importMessage.value = 'Örnek liste yüklendi'
}

function clearHistory() {
  history.value = []
  lastCode.value = ''
}

function openExcelPicker() {
  fileInputRef.value?.click()
}

async function importExcel(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]

  if (!file) {
    return
  }

  isImporting.value = true
  importMessage.value = `${file.name} okunuyor`

  try {
    const codes = new Set<string>()
    const isCsv = /\.csv$/i.test(file.name)
    const rows = isCsv ? await readCsvRows(file) : await readExcelRows(file)

    for (const row of rows) {
      for (const value of row) {
        if (isLikelyBarcode(value)) {
          codes.add(normalizeCode(value))
        }
      }
    }

    if (!codes.size) {
      importMessage.value = 'Excel içinde barkod bulunamadı'
      return
    }

    barcodeListText.value = [...codes].join('\n')
    importMessage.value = `${codes.size.toLocaleString('tr-TR')} barkod yüklendi`
  } catch (error) {
    importMessage.value =
      error instanceof Error ? error.message : 'Excel dosyası okunamadı'
  } finally {
    isImporting.value = false
    input.value = ''
  }
}

async function readExcelRows(file: File) {
  const { default: readXlsxFile } = await import('read-excel-file/browser')
  const sheets = await readXlsxFile(file)

  return sheets.flatMap((sheet) => sheet.data)
}

async function readCsvRows(file: File) {
  const text = await file.text()

  return text
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => line.split(/[;,]\s*|\t/))
}

async function startScanner() {
  if (!import.meta.client || isScanning.value) {
    return
  }

  cameraError.value = ''
  scannerMessage.value = 'Kamera başlatılıyor'

  try {
    await requestCameraPermission()

    const [{ BrowserMultiFormatReader }, { BarcodeFormat, DecodeHintType }] =
      await Promise.all([import('@zxing/browser'), import('@zxing/library')])

    const hints = new Map()
    hints.set(DecodeHintType.POSSIBLE_FORMATS, [
      BarcodeFormat.EAN_13,
      BarcodeFormat.EAN_8,
      BarcodeFormat.UPC_A,
      BarcodeFormat.UPC_E,
      BarcodeFormat.CODE_128,
      BarcodeFormat.CODE_39,
      BarcodeFormat.CODE_93,
      BarcodeFormat.ITF,
      BarcodeFormat.CODABAR
    ])
    hints.set(DecodeHintType.TRY_HARDER, true)

    const reader = new BrowserMultiFormatReader(hints, {
      delayBetweenScanAttempts: 80,
      delayBetweenScanSuccess: 700
    })

    isScanning.value = true
    scannerMessage.value = 'Barkod aranıyor'

    controlsRef.value = await reader.decodeFromConstraints(
      getCameraConstraints(),
      videoRef.value,
      (result, error) => {
        const text = result?.getText()

        if (text && Date.now() - lastDetectedAt.value > 650) {
          lastDetectedAt.value = Date.now()
          scannerMessage.value = `Okundu: ${normalizeCode(text)}`
          checkCode(text)
        }

        if (error && error.name !== 'NotFoundException') {
          scannerMessage.value = 'Tarama sürüyor'
        }
      }
    )
    setupCameraEnhancements()
  } catch (error) {
    stopScanner()
    cameraError.value =
      error instanceof Error
        ? error.message
        : 'Kamera başlatılamadı. İzinleri kontrol edin.'
  }
}

async function refreshCameraPermission() {
  if (!import.meta.client || !navigator.permissions?.query) {
    return
  }

  try {
    const status = await navigator.permissions.query({
      name: 'camera' as PermissionName
    })

    cameraPermission.value = status.state as CameraPermissionState
    status.onchange = () => {
      cameraPermission.value = status.state as CameraPermissionState
    }
  } catch {
    cameraPermission.value = 'unknown'
  }
}

async function requestCameraPermission() {
  if (!import.meta.client) {
    return
  }

  if (!window.isSecureContext) {
    throw new Error(
      'Mobilde kamera izni için HTTPS gerekir. Telefonla açarken güvenli bağlantı kullanın.'
    )
  }

  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error('Bu tarayıcı kamera erişimini desteklemiyor.')
  }

  scannerMessage.value = 'Kamera izni bekleniyor'

  try {
    const stream = await navigator.mediaDevices.getUserMedia(getCameraConstraints())
    stream.getTracks().forEach((track) => track.stop())
    cameraPermission.value = 'granted'
  } catch (error) {
    cameraPermission.value = 'denied'

    if (error instanceof DOMException && error.name === 'NotAllowedError') {
      throw new Error(
        'Kamera izni reddedildi. Tarayıcı ayarlarından bu site için kamerayı açın.'
      )
    }

    throw error
  }
}

async function requestCameraPermissionFromButton() {
  cameraError.value = ''

  try {
    await requestCameraPermission()
    scannerMessage.value = 'Kamera izni alındı'
  } catch (error) {
    scannerMessage.value = 'Kamera hazır'
    cameraError.value =
      error instanceof Error ? error.message : 'Kamera izni alınamadı.'
  }
}

function getCameraConstraints() {
  return {
    audio: false,
    video: {
      facingMode: { ideal: 'environment' },
      width: { ideal: 1920 },
      height: { ideal: 1080 },
      frameRate: { ideal: 30 }
    }
  } satisfies MediaStreamConstraints
}

function setupCameraEnhancements() {
  const controls = controlsRef.value

  resetCameraEnhancements(false)

  if (!controls?.streamVideoCapabilitiesGet) {
    return
  }

  try {
    const capabilities = controls.streamVideoCapabilitiesGet(() => true) as
      | (MediaTrackCapabilities & {
          torch?: boolean
          zoom?: { min?: number; max?: number; step?: number }
        })
      | undefined

    isTorchSupported.value = Boolean(capabilities?.torch && controls.switchTorch)

    if (capabilities?.zoom) {
      zoomMin.value = capabilities.zoom.min ?? 1
      zoomMax.value = capabilities.zoom.max ?? zoomMin.value
      zoomStep.value = capabilities.zoom.step ?? 0.1
      zoomValue.value = Math.min(Math.max(2, zoomMin.value), zoomMax.value)
      isZoomSupported.value = zoomMax.value > zoomMin.value

      if (isZoomSupported.value) {
        applyZoom()
      }
    }
  } catch {
    resetCameraEnhancements(false)
  }
}

function applyZoom() {
  const zoom = Number(zoomValue.value)

  controlsRef.value?.streamVideoConstraintsApply?.(
    { advanced: [{ zoom } as MediaTrackConstraintSet] },
    (tracks) => tracks
  )
}

async function toggleTorch() {
  if (!controlsRef.value?.switchTorch) {
    return
  }

  isTorchOn.value = !isTorchOn.value
  await controlsRef.value.switchTorch(isTorchOn.value)
}

function resetCameraEnhancements(resetZoom = true) {
  isTorchOn.value = false
  isTorchSupported.value = false
  isZoomSupported.value = false

  if (resetZoom) {
    zoomValue.value = 1
    zoomMin.value = 1
    zoomMax.value = 1
    zoomStep.value = 0.1
  }
}

function stopScanner() {
  controlsRef.value?.stop()
  controlsRef.value = null
  isScanning.value = false
  resetCameraEnhancements()
  scannerMessage.value = 'Kamera hazır'
}
</script>

<template>
  <main class="app-shell">
    <section class="topbar">
      <div>
        <p class="eyebrow">Barkod kontrol</p>
        <h1>Barkod Okuyucu</h1>
      </div>
      <div class="stats" aria-label="Barkod istatistikleri">
        <span><ClipboardList :size="17" /> {{ totalCodes }} kayıt</span>
        <span class="success"><CheckCircle2 :size="17" /> {{ foundCount }} var</span>
        <span class="danger"><XCircle :size="17" /> {{ missingCount }} yok</span>
      </div>
    </section>

    <section class="workspace">
      <div class="scanner-panel">
        <div class="camera-frame">
          <video ref="videoRef" autoplay muted playsinline />
          <div class="scan-target" />
          <div class="scan-line" />
          <div v-if="!isScanning" class="camera-placeholder">
            <Camera :size="42" />
            <span>Kamera bekliyor</span>
          </div>
        </div>

        <div class="scan-status" :class="{ active: isScanning }">
          {{ scannerMessage }}
        </div>

        <div class="scanner-actions">
          <button
            v-if="!isScanning && cameraPermission !== 'granted'"
            class="permission-button"
            type="button"
            title="Kamera izni ver"
            @click="requestCameraPermissionFromButton"
          >
            <ShieldCheck :size="18" />
            Kamera izni ver
          </button>
          <button
            v-if="!isScanning"
            class="primary-button"
            type="button"
            title="Kamerayı başlat"
            @click="startScanner"
          >
            <Play :size="18" />
            Kamerayı başlat
          </button>
          <button
            v-else
            class="secondary-button"
            type="button"
            title="Kamerayı durdur"
            @click="stopScanner"
          >
            <Pause :size="18" />
            Durdur
          </button>
          <button
            v-if="isScanning && isTorchSupported"
            class="torch-button"
            :class="{ active: isTorchOn }"
            type="button"
            title="Feneri aç veya kapat"
            @click="toggleTorch"
          >
            <Camera :size="18" />
            {{ isTorchOn ? 'Fener açık' : 'Fener' }}
          </button>
        </div>

        <div v-if="isScanning && isZoomSupported" class="camera-tools">
          <label for="camera-zoom">
            <ZoomIn :size="17" />
            Yakınlaştır
          </label>
          <input
            id="camera-zoom"
            v-model.number="zoomValue"
            :max="zoomMax"
            :min="zoomMin"
            :step="zoomStep"
            type="range"
            @input="applyZoom"
          >
          <span>{{ zoomValue.toFixed(1) }}x</span>
        </div>

        <p v-if="cameraError" class="error-text">{{ cameraError }}</p>

        <form class="manual-check" @submit.prevent="checkCode(manualCode)">
          <label for="manual-code">Manuel barkod</label>
          <div class="input-row">
            <input
              id="manual-code"
              v-model="manualCode"
              autocomplete="off"
              inputmode="text"
              placeholder="Barkodu gir veya okut"
            >
            <button type="submit" title="Barkodu kontrol et">
              <Search :size="18" />
              Kontrol et
            </button>
          </div>
        </form>

        <div
          class="result"
          :class="{
            'result-found': lastStatus === 'found',
            'result-missing': lastStatus === 'missing'
          }"
        >
          <span class="result-label">
            {{
              lastStatus === 'found'
                ? 'Listede var'
                : lastStatus === 'missing'
                  ? 'Listede yok'
                  : 'Sonuç bekleniyor'
            }}
          </span>
          <strong>{{ lastCode || 'Barkod okutun' }}</strong>
        </div>
      </div>

      <div class="list-panel">
        <div class="panel-heading">
          <div>
            <h2>Barkod listesi</h2>
            <p>Excel yükleyin veya her satıra bir barkod yazın.</p>
          </div>
          <div class="list-actions">
            <input
              ref="fileInputRef"
              accept=".xlsx,.xls,.csv"
              class="file-input"
              type="file"
              @change="importExcel"
            >
            <button
              type="button"
              class="ghost-button"
              :disabled="isImporting"
              @click="openExcelPicker"
            >
              <Loader2 v-if="isImporting" :size="18" class="spin" />
              <FileSpreadsheet v-else :size="18" />
              Excel yükle
            </button>
            <button type="button" class="ghost-button" @click="loadSampleList">
              Örnek liste
            </button>
          </div>
        </div>

        <p v-if="importMessage" class="import-message">{{ importMessage }}</p>

        <textarea
          v-model="barcodeListText"
          spellcheck="false"
          placeholder="8690632030014&#10;5449000000996&#10;3017620422003"
        />

        <div class="history">
          <div class="history-heading">
            <h2>Son kontroller</h2>
            <button
              type="button"
              class="icon-button"
              title="Geçmişi temizle"
              @click="clearHistory"
            >
              <Trash2 :size="18" />
            </button>
          </div>

          <ul v-if="history.length">
            <li
              v-for="item in history"
              :key="`${item.code}-${item.time}`"
              :class="item.status"
            >
              <span>{{ item.code }}</span>
              <strong>{{ item.status === 'found' ? 'VAR' : 'YOK' }}</strong>
              <time>{{ item.time }}</time>
            </li>
          </ul>
          <p v-else class="empty-state">Henüz kontrol yapılmadı.</p>
        </div>
      </div>
    </section>
  </main>
</template>

<style scoped>
:global(*) {
  box-sizing: border-box;
}

:global(body) {
  margin: 0;
  background: #f4f7f6;
}

.app-shell {
  min-height: 100vh;
  padding: 28px;
  font-family:
    Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI",
    sans-serif;
  color: #18211f;
  background:
    linear-gradient(120deg, rgba(20, 184, 166, 0.12), transparent 34%),
    linear-gradient(300deg, rgba(59, 130, 246, 0.1), transparent 38%),
    #f4f7f6;
}

.topbar {
  display: flex;
  align-items: end;
  justify-content: space-between;
  gap: 20px;
  width: min(1180px, 100%);
  margin: 0 auto 24px;
}

.eyebrow {
  margin: 0 0 8px;
  color: #0f766e;
  font-size: 0.78rem;
  font-weight: 800;
  letter-spacing: 0;
  text-transform: uppercase;
}

h1,
h2,
p {
  margin: 0;
}

h1 {
  font-size: 2.4rem;
  line-height: 1;
}

h2 {
  font-size: 1rem;
}

.stats {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 8px;
}

.stats span {
  min-height: 38px;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border: 1px solid #d6e1de;
  border-radius: 8px;
  background: #ffffff;
  color: #334155;
  font-weight: 700;
}

.stats .success {
  color: #047857;
}

.stats .danger {
  color: #b91c1c;
}

.workspace {
  width: min(1180px, 100%);
  margin: 0 auto;
  display: grid;
  grid-template-columns: minmax(320px, 0.9fr) minmax(360px, 1.1fr);
  gap: 18px;
  align-items: start;
}

.scanner-panel,
.list-panel {
  border: 1px solid #d6e1de;
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.88);
  box-shadow: 0 12px 34px rgba(15, 23, 42, 0.08);
}

.scanner-panel {
  padding: 16px;
}

.camera-frame {
  position: relative;
  overflow: hidden;
  aspect-ratio: 4 / 3;
  border-radius: 8px;
  background: #111827;
}

video {
  width: 100%;
  height: 100%;
  display: block;
  object-fit: cover;
}

.scan-line {
  position: absolute;
  left: 10%;
  right: 10%;
  top: 50%;
  height: 2px;
  background: #22c55e;
  box-shadow: 0 0 18px rgba(34, 197, 94, 0.9);
}

.scan-target {
  position: absolute;
  left: 12%;
  right: 12%;
  top: 34%;
  bottom: 34%;
  border: 2px solid rgba(255, 255, 255, 0.76);
  border-radius: 8px;
  box-shadow:
    0 0 0 999px rgba(15, 23, 42, 0.16),
    inset 0 0 24px rgba(34, 197, 94, 0.18);
  pointer-events: none;
}

.camera-placeholder {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  align-content: center;
  gap: 10px;
  color: #cbd5e1;
  font-weight: 700;
}

.scanner-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  margin-top: 12px;
}

.scan-status {
  min-height: 38px;
  display: flex;
  align-items: center;
  margin-top: 10px;
  padding: 8px 10px;
  border: 1px solid #d6e1de;
  border-radius: 8px;
  background: #f8fafc;
  color: #64748b;
  font-size: 0.9rem;
  font-weight: 800;
}

.scan-status.active {
  border-color: #99f6e4;
  background: #f0fdfa;
  color: #0f766e;
}

button {
  min-height: 42px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  border: 0;
  border-radius: 8px;
  font: inherit;
  font-weight: 800;
  cursor: pointer;
}

button:disabled {
  cursor: wait;
  opacity: 0.72;
}

.primary-button,
.manual-check button {
  padding: 0 16px;
  background: #0f766e;
  color: #ffffff;
}

.permission-button {
  padding: 0 16px;
  border: 1px solid #bfdbfe;
  background: #eff6ff;
  color: #1d4ed8;
}

.torch-button {
  padding: 0 16px;
  border: 1px solid #fde68a;
  background: #fffbeb;
  color: #92400e;
}

.torch-button.active {
  background: #f59e0b;
  color: #ffffff;
}

.secondary-button {
  padding: 0 16px;
  background: #334155;
  color: #ffffff;
}

.camera-tools {
  display: grid;
  grid-template-columns: auto minmax(120px, 1fr) auto;
  gap: 10px;
  align-items: center;
  margin-top: 12px;
  padding: 10px;
  border: 1px solid #d6e1de;
  border-radius: 8px;
  background: #ffffff;
}

.camera-tools label {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: #334155;
}

.camera-tools input {
  height: auto;
  padding: 0;
}

.camera-tools span {
  color: #0f766e;
  font-weight: 900;
}

.ghost-button,
.icon-button {
  border: 1px solid #d6e1de;
  background: #ffffff;
  color: #334155;
}

.ghost-button {
  padding: 0 12px;
}

.icon-button {
  width: 42px;
  padding: 0;
}

.error-text {
  margin-top: 10px;
  color: #b91c1c;
  font-size: 0.92rem;
  line-height: 1.45;
}

.manual-check {
  display: grid;
  gap: 8px;
  margin-top: 16px;
}

label {
  color: #475569;
  font-size: 0.85rem;
  font-weight: 800;
}

.input-row {
  display: grid;
  grid-template-columns: 1fr auto;
  gap: 8px;
}

input,
textarea {
  width: 100%;
  border: 1px solid #cbd5d9;
  border-radius: 8px;
  background: #ffffff;
  color: #172121;
  font: inherit;
}

input {
  min-width: 0;
  height: 42px;
  padding: 0 12px;
}

textarea {
  min-height: 292px;
  resize: vertical;
  padding: 12px;
  font-family: "SFMono-Regular", Consolas, "Liberation Mono", monospace;
  line-height: 1.6;
}

.result {
  display: grid;
  gap: 6px;
  margin-top: 16px;
  padding: 16px;
  border: 1px solid #d6e1de;
  border-radius: 8px;
  background: #f8fafc;
}

.result-label {
  color: #64748b;
  font-size: 0.82rem;
  font-weight: 800;
  text-transform: uppercase;
}

.result strong {
  overflow-wrap: anywhere;
  font-size: 1.8rem;
}

.result-found {
  border-color: #86efac;
  background: #ecfdf5;
}

.result-found .result-label,
.result-found strong {
  color: #047857;
}

.result-missing {
  border-color: #fecaca;
  background: #fef2f2;
}

.result-missing .result-label,
.result-missing strong {
  color: #b91c1c;
}

.list-panel {
  display: grid;
  gap: 14px;
  padding: 16px;
}

.panel-heading,
.history-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.list-actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 8px;
}

.file-input {
  display: none;
}

.import-message {
  min-height: 34px;
  display: flex;
  align-items: center;
  padding: 7px 10px;
  border: 1px solid #bfdbfe;
  border-radius: 8px;
  background: #eff6ff;
  color: #1d4ed8;
  font-size: 0.9rem;
  font-weight: 800;
}

.spin {
  animation: spin 0.9s linear infinite;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

.panel-heading p {
  margin-top: 5px;
  color: #64748b;
  font-size: 0.92rem;
}

.history {
  display: grid;
  gap: 10px;
}

ul {
  display: grid;
  gap: 8px;
  margin: 0;
  padding: 0;
  list-style: none;
}

li {
  display: grid;
  grid-template-columns: 1fr auto auto;
  gap: 10px;
  align-items: center;
  min-height: 42px;
  padding: 8px 10px;
  border: 1px solid #dbe5e2;
  border-radius: 8px;
  background: #ffffff;
}

li span {
  overflow-wrap: anywhere;
  font-weight: 800;
}

li strong {
  font-size: 0.78rem;
}

li time {
  color: #64748b;
  font-size: 0.84rem;
}

li.found strong {
  color: #047857;
}

li.missing strong {
  color: #b91c1c;
}

.empty-state {
  min-height: 52px;
  display: grid;
  place-items: center;
  border: 1px dashed #cbd5d9;
  border-radius: 8px;
  color: #64748b;
}

@media (max-width: 820px) {
  .app-shell {
    padding: 18px;
  }

  .topbar {
    align-items: stretch;
    flex-direction: column;
  }

  .stats {
    justify-content: flex-start;
  }

  .workspace {
    grid-template-columns: 1fr;
  }

  .input-row {
    grid-template-columns: 1fr;
  }

  .panel-heading {
    align-items: stretch;
    flex-direction: column;
  }

  .list-actions {
    justify-content: flex-start;
  }

  .manual-check button {
    width: 100%;
  }

  .scanner-actions button {
    width: 100%;
  }

  li {
    grid-template-columns: 1fr auto;
  }

  li time {
    grid-column: 1 / -1;
  }
}
</style>
