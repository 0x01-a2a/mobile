import AVFoundation
import UIKit

/// Keeps the app process alive in the background when the zerox1 node is running
/// or zeroclaw is actively processing a task.
///
/// Strategy:
///   1. Silent audio session — iOS keeps background-audio processes alive indefinitely.
///      `audio` is already declared in UIBackgroundModes.
///   2. beginBackgroundTask — 30s extension on every background transition, used as
///      a bridge while the audio session initialises.
///   3. Two keep-alive signals:
///      a. Node running — audio is held for the entire node lifetime so the mesh
///         process is never suspended. Covers local-node mode fully.
///      b. Zeroclaw busy file — for hosted mode (no local node), audio is held only
///         while `$dataDir/zeroclaw.busy` exists (written by the Rust FFI layer on
///         task accept, deleted on task completion).
///
/// Audio stops only when BOTH the node has stopped AND zeroclaw is idle.
final class KeepAliveService {
    static let shared = KeepAliveService()

    private var audioEngine: AVAudioEngine?
    private var audioPlayerNode: AVAudioPlayerNode?
    private var bgTaskId: UIBackgroundTaskIdentifier = .invalid
    private var pollTimer: Timer?
    private var isAudioActive = false
    private var dataDir: URL?

    // Two independent signals — audio runs while either is true.
    private var isNodeRunning = false
    private var isZeroclawBusyFlag = false

    // MARK: - Node lifecycle

    func nodeDidStart(dataDir: URL) {
        self.dataDir = dataDir
        isNodeRunning = true
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
        // If we're already in the background (e.g. VoIP wake started the node),
        // start audio immediately without waiting for the next background transition.
        if UIApplication.shared.applicationState == .background {
            beginBgTask()
            startAudio()
            startPolling()
        }
    }

    func nodeDidStop() {
        isNodeRunning = false
        evaluateAudio()
        endBgTask()
        pollTimer?.invalidate()
        pollTimer = nil
        NotificationCenter.default.removeObserver(self)
        dataDir = nil
    }

    // MARK: - Background / foreground hooks

    @objc private func appDidBackground() {
        beginBgTask()
        startPolling()
        // Node running → always hold audio; otherwise check zeroclaw.
        evaluateAudio()
    }

    @objc private func appWillForeground() {
        // Process is awake; release background resources but keep node running.
        stopAudio()
        endBgTask()
        pollTimer?.invalidate()
        pollTimer = nil
    }

    // MARK: - Polling (zeroclaw busy file, for hosted mode)

    private func startPolling() {
        pollTimer?.invalidate()
        pollTimer = Timer.scheduledTimer(withTimeInterval: 5.0, repeats: true) { [weak self] _ in
            guard let self else { return }
            self.isZeroclawBusyFlag = self.readZeroclawBusy()
            self.evaluateAudio()
        }
    }

    private func readZeroclawBusy() -> Bool {
        guard let dataDir else { return false }
        return FileManager.default.fileExists(
            atPath: dataDir.appendingPathComponent("zeroclaw.busy").path
        )
    }

    /// Start or stop the audio session based on the current state of both signals.
    private func evaluateAudio() {
        if isNodeRunning || isZeroclawBusyFlag {
            startAudio()
        } else {
            stopAudio()
        }
    }

    // MARK: - Silent audio

    private func startAudio() {
        guard !isAudioActive else { return }
        do {
            try AVAudioSession.sharedInstance().setCategory(
                .playback,
                mode: .default,
                options: [.mixWithOthers]   // don't interrupt podcasts or music
            )
            try AVAudioSession.sharedInstance().setActive(true)

            let engine = AVAudioEngine()
            let player = AVAudioPlayerNode()
            let sampleRate = 44100.0
            let format = AVAudioFormat(standardFormatWithSampleRate: sampleRate, channels: 1)!
            let frameCount = AVAudioFrameCount(sampleRate)
            let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: frameCount)!
            buffer.frameLength = frameCount
            // Buffer is zero-initialised (silent)

            engine.attach(player)
            engine.connect(player, to: engine.mainMixerNode, format: format)
            try engine.start()
            player.scheduleBuffer(buffer, at: nil, options: .loops)
            player.play()

            // Retain both so they are not deallocated when startAudio() returns.
            audioEngine = engine
            audioPlayerNode = player
            isAudioActive = true
            NSLog("[KeepAlive] Silent audio started — node=\(isNodeRunning) zeroclaw=\(isZeroclawBusyFlag)")
        } catch {
            NSLog("[KeepAlive] Failed to start silent audio: \(error)")
        }
    }

    private func stopAudio() {
        guard isAudioActive else { return }
        audioPlayerNode?.stop()
        audioEngine?.stop()
        audioEngine = nil
        audioPlayerNode = nil
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        isAudioActive = false
        NSLog("[KeepAlive] Silent audio stopped")
    }

    // MARK: - Background task

    private func beginBgTask() {
        guard bgTaskId == .invalid else { return }
        bgTaskId = UIApplication.shared.beginBackgroundTask(withName: "zerox1.keepalive") { [weak self] in
            // Expiration handler — system is about to suspend; clean up gracefully.
            self?.stopAudio()
            self?.endBgTask()
        }
    }

    private func endBgTask() {
        guard bgTaskId != .invalid else { return }
        UIApplication.shared.endBackgroundTask(bgTaskId)
        bgTaskId = .invalid
    }
}
