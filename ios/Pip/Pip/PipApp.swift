import SwiftUI
import UserNotifications

@main
struct PipApp: App {
    @State private var model = AppModel()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(model)
                .task {
                    UNUserNotificationCenter.current().delegate = PipNotificationDelegate.shared
                    await model.bootstrap()
                }
        }
    }
}
