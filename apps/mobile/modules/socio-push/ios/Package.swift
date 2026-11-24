// swift-tools-version:5.9
// The decryptor's tests (../README.md, Tests): `swift test` in this folder on a Mac, or
// xcodebuild test against an iOS simulator. CocoaPods ignores this file (SocioPush.podspec).
import PackageDescription

let package = Package(
  name: "SocioPushShared",
  platforms: [.iOS("17.4"), .macOS(.v14)],
  products: [.library(name: "SocioPushShared", targets: ["SocioPushShared"])],
  targets: [
    .target(name: "SocioPushShared", path: "Shared"),
    .testTarget(name: "SocioPushSharedTests", dependencies: ["SocioPushShared"], path: "Tests/SocioPushSharedTests"),
  ]
)
