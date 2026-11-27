package expo.modules.socioscanner

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/** `SocioScanner`: one native view, the QR scanner's camera (README.md). */
class SocioScannerModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("SocioScanner")

    View(SocioScannerView::class) {
      Events("onCode", "onMountError")

      Prop("torch") { view: SocioScannerView, on: Boolean? ->
        view.setTorch(on ?: false)
      }

      Prop("active") { view: SocioScannerView, on: Boolean? ->
        view.setActive(on ?: true)
      }

      OnViewDestroys { view: SocioScannerView ->
        view.release()
      }
    }
  }
}
