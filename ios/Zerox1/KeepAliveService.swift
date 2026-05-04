import AVFoundation
import UIKit
import os.log

/// Keeps the app process alive in the background when the zerox1 node is running
/// or zeroclaw is actively processing a task.
///
/// Audio strategy (two modes):
///   STANDBY — node is running but zeroclaw is idle.
///             Silent audio session (.playback, .mixWithOthers) holds the process
///             alive so incoming push wakes are handled immediately.
///   ACTIVE  — zeroclaw.busy file exists (task in progress).
///             Audible ambient sound plays, making agent activity transparent to
///             the user and providing legitimate justification for UIBackgroundModes audio.
///
/// Sound selection:
///   The task type is read from `$dataDir/zeroclaw.task_type` (written by the JS
///   layer via NodeModule.setAgentTaskType when a task is accepted).
///   Each type maps to a bundled .caf file; falls back to a generated sine tone.
///
///   Type          File                          Character
///   ──────────────────────────────────────────────────────
///   page_flip     agent_working_page_flip.caf   reading/summarization
///   keyboard      agent_working_keyboard.caf    coding/translation
///   rain          agent_working_rain.caf        data analysis
///   ocean         agent_working_ocean.caf       Q&A / research
///   (default)     generated 440 Hz sine, 3%    generic fallback
final class KeepAliveService {
    static let shared = KeepAliveService()

    private enum AudioMode: Equatable { case off, standby, active(String) }

    private var audioEngine: AVAudioEngine?
    private var audioPlayerNode: AVAudioPlayerNode?
    private var bgTaskId: UIBackgroundTaskIdentifier = .invalid
    private var pollSource: DispatchSourceTimer?
    private var currentMode: AudioMode = .off
    private var dataDir: URL?

    private var isNodeRunning = false
    private var isZeroclawBusyFlag = false
    private var isMuted = false

    // MARK: - Mute control

    func setMuted(_ muted: Bool) {
        isMuted = muted
        audioPlayerNode?.volume = muted ? 0.0 : 1.0
        os_log(.debug, "[KeepAlive] audio muted → %{public}d", muted ? 1 : 0)
    }

    // MARK: - Node lifecycle

    func nodeDidStart(dataDir: URL) {
        self.dataDir = dataDir
        isNodeRunning = true
        // Remove any previously registered observers before adding new ones to prevent
        // duplicates when the node is stopped and restarted within the same process.
        NotificationCenter.default.removeObserver(self)
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(appDidBackground),
            name: UIApplication.didEnterBackgroundNotification,
            object: nil
        )
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(appWillForeground),
            name: UIApplication.willEnterForegroundNotification,
            object: nil
        )
        if UIApplication.shared.applicationState == .background {
            beginBgTask()
            evaluateAudio()
            startPolling()
        }
    }

    func nodeDidStop() {
        isNodeRunning = false
        evaluateAudio()
        endBgTask()
        stopPolling()
        NotificationCenter.default.removeObserver(self)
        dataDir = nil
    }

    // MARK: - Background / foreground hooks

    @objc private func appDidBackground() {
        beginBgTask()
        startPolling()
        evaluateAudio()
    }

    @objc private func appWillForeground() {
        transitionTo(.off)
        endBgTask()
        stopPolling()
    }

    // MARK: - Polling (zeroclaw busy + task type files)

    private func startPolling() {
        stopPolling()
        let source = DispatchSource.makeTimerSource(queue: DispatchQueue.global(qos: .utility))
        source.schedule(deadline: .now() + 5.0, repeating: 5.0)
        source.setEventHandler { [weak self] in self?.evaluateAudio() }
        source.resume()
        pollSource = source
    }

    private func stopPolling() {
        pollSource?.cancel()
        pollSource = nil
    }

    private func readZeroclawBusy() -> Bool {
        guard let dataDir else { return false }
        return FileManager.default.fileExists(
            atPath: dataDir.appendingPathComponent("zeroclaw.busy").path
        )
    }

    /// Returns the sound category written by JS when a task was accepted.
    /// Values: "page_flip" | "keyboard" | "rain" | "ocean" | "" (default)
    private func readTaskType() -> String {
        guard let dataDir else { return "" }
        let path = dataDir.appendingPathComponent("zeroclaw.task_type")
        return (try? String(contentsOf: path, encoding: .utf8))
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            ?? ""
    }

    // MARK: - Audio mode evaluation

    private func evaluateAudio() {
        guard isNodeRunning else { transitionTo(.off); return }
        isZeroclawBusyFlag = readZeroclawBusy()
        if isZeroclawBusyFlag {
            transitionTo(.active(readTaskType()))
        } else {
            transitionTo(.standby)
        }
    }

    private func transitionTo(_ target: AudioMode) {
        guard target != currentMode else { return }
        let prev = currentMode
        currentMode = target
        switch target {
        case .off:
            stopAudio()
        case .standby:
            if case .active = prev {
                swapBuffer(audible: false, taskType: "")
            } else {
                startSession()
                scheduleBuffer(audible: false, taskType: "")
            }
        case .active(let taskType):
            if case .standby = prev {
                swapBuffer(audible: true, taskType: taskType)
            } else if case .active(let prev) = prev, prev != taskType {
                // Task type changed mid-task — swap sound
                swapBuffer(audible: true, taskType: taskType)
            } else {
                startSession()
                scheduleBuffer(audible: true, taskType: taskType)
            }
        }
        os_log(.debug, "[KeepAlive] mode → %{public}@ (busy=%{public}d)",
               String(describing: target), isZeroclawBusyFlag ? 1 : 0)
    }

    // MARK: - AVAudioEngine setup

    private func startSession() {
        do {
            try AVAudioSession.sharedInstance().setCategory(
                .playback, mode: .default, options: [.mixWithOthers]
            )
            try AVAudioSession.sharedInstance().setActive(true)
            let engine = AVAudioEngine()
            let player = AVAudioPlayerNode()
            let format = AVAudioFormat(standardFormatWithSampleRate: 44100, channels: 1)!
            engine.attach(player)
            engine.connect(player, to: engine.mainMixerNode, format: format)
            try engine.start()
            audioEngine = engine
            audioPlayerNode = player
        } catch {
            os_log(.error, "[KeepAlive] AVAudioEngine start failed: %{public}@", error.localizedDescription)
        }
    }

    private func scheduleBuffer(audible: Bool, taskType: String) {
        guard let player = audioPlayerNode else { return }
        player.stop()
        player.scheduleBuffer(makeBuffer(audible: audible, taskType: taskType),
                              at: nil, options: .loops)
        player.volume = isMuted ? 0.0 : 1.0
        player.play()
    }

    private func swapBuffer(audible: Bool, taskType: String) {
        guard let player = audioPlayerNode else { return }
        player.stop()
        player.scheduleBuffer(makeBuffer(audible: audible, taskType: taskType),
                              at: nil, options: .loops)
        player.volume = isMuted ? 0.0 : 1.0
        player.play()
    }

    private func stopAudio() {
        audioPlayerNode?.stop()
        audioEngine?.stop()
        audioEngine = nil
        audioPlayerNode = nil
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }

    // MARK: - Buffer generation

    private func makeBuffer(audible: Bool, taskType: String) -> AVAudioPCMBuffer {
        guard audible else { return makeSilentBuffer() }
        return makeAudibleBuffer(taskType: taskType)
    }

    /// Audible ambient buffer — tries bundled .caf file first, falls back to sine tone.
    private func makeAudibleBuffer(taskType: String) -> AVAudioPCMBuffer {
        let sampleRate: Double = 44100
        let format = AVAudioFormat(standardFormatWithSampleRate: sampleRate, channels: 1)!

        // Map task type → bundled file name
        let fileName: String
        switch taskType {
        case "page_flip": fileName = "agent_working_page_flip"
        case "keyboard":  fileName = "agent_working_keyboard"
        case "rain":      fileName = "agent_working_rain"
        case "ocean":     fileName = "agent_working_ocean"
        default:          fileName = "agent_working_ambient"
        }

        // Try bundled .caf
        if let url = Bundle.main.url(forResource: fileName, withExtension: "caf"),
           let file = try? AVAudioFile(forReading: url),
           let buffer = AVAudioPCMBuffer(pcmFormat: format,
                                         frameCapacity: AVAudioFrameCount(file.length)) {
            try? file.read(into: buffer)
            if buffer.frameLength > 0 { return buffer }
        }

        // Fallback: soft 440 Hz sine, 3% amplitude, 4-second loop
        let frameCount = AVAudioFrameCount(sampleRate * 4.0)
        let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: frameCount)!
        buffer.frameLength = frameCount
        let data = buffer.floatChannelData![0]
        let amplitude: Float = 0.03
        for i in 0..<Int(frameCount) {
            data[i] = amplitude * sinf(Float(2.0 * .pi * 440.0 * Double(i) / sampleRate))
        }
        return buffer
    }

    /// Silent 1-second buffer — holds the audio session open without audible output.
    private func makeSilentBuffer() -> AVAudioPCMBuffer {
        let format = AVAudioFormat(standardFormatWithSampleRate: 44100, channels: 1)!
        let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 44100)!
        buffer.frameLength = 44100
        return buffer
    }

    // MARK: - Background task

    private func beginBgTask() {
        guard bgTaskId == .invalid else { return }
        bgTaskId = UIApplication.shared.beginBackgroundTask(withName: "zerox1.keepalive") { [weak self] in
            self?.transitionTo(.off)
            self?.endBgTask()
        }
    }

    private func endBgTask() {
        guard bgTaskId != .invalid else { return }
        UIApplication.shared.endBackgroundTask(bgTaskId)
        bgTaskId = .invalid
    }
}
