import SwiftUI

struct RootView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        @Bindable var model = model
        TabView(selection: $model.selectedTab) {
            NavigationStack {
                HomeView()
            }
                .tabItem { Label("Pip", systemImage: "bird") }
                .tag(AppTab.home)

            TodayPlanView()
                .tabItem { Label("Today", systemImage: "checklist") }
                .tag(AppTab.today)

            ScheduleView()
                .tabItem { Label("Schedule", systemImage: "calendar") }
                .tag(AppTab.schedule)

            HistoryView()
                .tabItem { Label("History", systemImage: "clock.arrow.circlepath") }
                .tag(AppTab.history)
        }
        .tint(PipDesign.accent)
        .preferredColorScheme(.light)
        .overlay(alignment: .top) {
            if let banner = model.errorBanner {
                BannerView(text: banner) {
                    model.dismissBanner()
                }
                .transition(.move(edge: .top).combined(with: .opacity))
            }
        }
        .fullScreenCover(item: $model.focusSession) { session in
            FocusSessionView(session: session)
                .environment(model)
        }
    }
}

#Preview {
    RootView()
        .environment(AppModel.preview())
}
