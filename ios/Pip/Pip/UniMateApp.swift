import SwiftUI
import UserNotifications

@main
struct UniMateApp: App {
    @State private var model = AppModel()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(model)
                .task {
                    UNUserNotificationCenter.current().delegate = UniMateNotificationDelegate.shared
                    await model.bootstrap()
                }
        }
    }
}
