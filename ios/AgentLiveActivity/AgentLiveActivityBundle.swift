import WidgetKit
import SwiftUI

@main
struct AgentLiveActivityBundle: WidgetBundle {
    var body: some Widget {
        if #available(iOS 16.1, *) {
            AgentLiveActivityWidget()
        }
    }
}
