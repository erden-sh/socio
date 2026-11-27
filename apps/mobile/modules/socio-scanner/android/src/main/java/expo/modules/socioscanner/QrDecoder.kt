package expo.modules.socioscanner

import com.google.zxing.BarcodeFormat
import com.google.zxing.BinaryBitmap
import com.google.zxing.ChecksumException
import com.google.zxing.DecodeHintType
import com.google.zxing.FormatException
import com.google.zxing.LuminanceSource
import com.google.zxing.NotFoundException
import com.google.zxing.PlanarYUVLuminanceSource
import com.google.zxing.common.HybridBinarizer
import com.google.zxing.qrcode.QRCodeReader

/**
 * QR codes only, read from a camera frame's luminance (the Y plane): ZXing's QRCodeReader with
 * TRY_HARDER over a HybridBinarizer, then once more on the inverted image (light on dark). The
 * whole frame is read in halves too (`decodeWide`), never with ZXing's multi-code reader, whose
 * time grows past seconds with many codes in view. A QR code reads at any rotation, so the
 * frame's rotation doesn't matter. Not thread-safe: one per analyzer thread.
 */
class QrDecoder {
  private val reader = QRCodeReader()
  private val hints = mapOf(
    DecodeHintType.POSSIBLE_FORMATS to listOf(BarcodeFormat.QR_CODE),
    DecodeHintType.TRY_HARDER to true
  )

  /**
   * The text of a QR code in `luma` (`width` x `height`, one byte a pixel, rows packed), looked for
   * in the centered square `fraction` of the shorter side wide, or null. A fraction of 1 or more
   * reads the whole frame (`decodeWide`).
   */
  fun decode(luma: ByteArray, width: Int, height: Int, fraction: Double): String? {
    if (fraction >= 1.0) return decodeWide(luma, width, height)
    val side = (minOf(width, height) * fraction).toInt().coerceAtMost(minOf(width, height))
    return decodeRegion(luma, width, height, (width - side) / 2, (height - side) / 2, side, side)
  }

  /**
   * The whole frame, then each half of it (left, right, top, bottom): with two codes in view the
   * reader can take finder patterns from both and read neither, and a half holds one of them.
   */
  fun decodeWide(luma: ByteArray, width: Int, height: Int): String? =
    decodeRegion(luma, width, height, 0, 0, width, height)
      ?: decodeRegion(luma, width, height, 0, 0, width / 2, height)
      ?: decodeRegion(luma, width, height, width / 2, 0, width - width / 2, height)
      ?: decodeRegion(luma, width, height, 0, 0, width, height / 2)
      ?: decodeRegion(luma, width, height, 0, height / 2, width, height - height / 2)

  private fun decodeRegion(luma: ByteArray, width: Int, height: Int, left: Int, top: Int, w: Int, h: Int): String? {
    val source = PlanarYUVLuminanceSource(luma, width, height, left, top, w, h, false)
    return read(source) ?: read(source.invert())
  }

  private fun read(source: LuminanceSource): String? =
    try {
      reader.decode(BinaryBitmap(HybridBinarizer(source)), hints).text
    } catch (_: NotFoundException) {
      null
    } catch (_: ChecksumException) {
      null
    } catch (_: FormatException) {
      null
    } finally {
      reader.reset()
    }
}
