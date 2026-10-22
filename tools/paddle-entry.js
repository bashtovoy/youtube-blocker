/* Einstieg für das lokale PaddleOCR-Bundle (setup.sh).
   Das SDK wird als IIFE gebündelt und stellt PaddleOCR global bereit; der
   OCR-Host lädt lib/paddle.bundle.js per <script> aus dem Erweiterungspaket. */
import { PaddleOCR } from '@paddleocr/paddleocr-js';

globalThis.PaddleOCR = PaddleOCR;
globalThis.PADDLE_SDK_VERSION = '0.4.2';
