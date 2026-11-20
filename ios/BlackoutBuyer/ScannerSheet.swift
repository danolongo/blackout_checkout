import SwiftUI
import AVFoundation

struct ScannerSheet: View {
  let onCode:(String)->Void
  @Environment(\.dismiss) private var dismiss
  @State private var pasted=""
  var body:some View {
    NavigationStack {
      ZStack {Color.black.ignoresSafeArea();VStack(spacing:20){CameraScanner(onCode:{onCode($0);dismiss()}).clipShape(RoundedRectangle(cornerRadius:20)).frame(height:390);Text("Scan the merchant invoice QR").foregroundStyle(.white);TextField("Or paste invoice JSON",text:$pasted,axis:.vertical).textInputAutocapitalization(.never).autocorrectionDisabled().padding().background(.white.opacity(0.12),in:RoundedRectangle(cornerRadius:12)).foregroundStyle(.white);Button("Use pasted invoice") {onCode(pasted);dismiss()}.disabled(pasted.isEmpty);Spacer()}.padding(24)}
      .navigationTitle("Scan to pay").navigationBarTitleDisplayMode(.inline).toolbar {ToolbarItem(placement:.topBarTrailing){Button("Cancel"){dismiss()}}}
    }
  }
}
struct CameraScanner:UIViewRepresentable {
  let onCode:(String)->Void
  func makeCoordinator()->Coordinator{Coordinator(onCode:onCode)}
  func makeUIView(context:Context)->UIView {
    let view=UIView();view.backgroundColor = .black
    let session=AVCaptureSession();context.coordinator.session=session
    guard let camera=AVCaptureDevice.default(for:.video),let input=try? AVCaptureDeviceInput(device:camera),session.canAddInput(input) else{return view}
    session.addInput(input)
    let output=AVCaptureMetadataOutput();guard session.canAddOutput(output) else{return view};session.addOutput(output)
    output.setMetadataObjectsDelegate(context.coordinator,queue:.main);output.metadataObjectTypes=[.qr]
    let layer=AVCaptureVideoPreviewLayer(session:session);layer.videoGravity = .resizeAspectFill;view.layer.addSublayer(layer);context.coordinator.layer=layer
    DispatchQueue.global(qos:.userInitiated).async { session.startRunning() }
    return view
  }
  func updateUIView(_ view:UIView,context:Context){context.coordinator.layer?.frame=view.bounds}
  static func dismantleUIView(_ view:UIView,coordinator:Coordinator){let session=coordinator.session;DispatchQueue.global(qos:.userInitiated).async {session?.stopRunning()}}
  final class Coordinator:NSObject,AVCaptureMetadataOutputObjectsDelegate {
    let onCode:(String)->Void;var session:AVCaptureSession?;var layer:AVCaptureVideoPreviewLayer?;var found=false
    init(onCode:@escaping(String)->Void){self.onCode=onCode}
    func metadataOutput(_ output:AVCaptureMetadataOutput,didOutput objects:[AVMetadataObject],from connection:AVCaptureConnection){guard !found,let qr=objects.first as? AVMetadataMachineReadableCodeObject,let value=qr.stringValue else{return};found=true;onCode(value)}
  }
}
