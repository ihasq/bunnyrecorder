import { 
    Output, 
    Mp4OutputFormat, 
    WebMOutputFormat, 
    BufferTarget, 
    CanvasSource, 
    AudioBufferSource, 
    QUALITY_HIGH, 
    QUALITY_MEDIUM, 
    QUALITY_LOW 
} from 'mediabunny';

/**
 * MediaBunny-based MediaRecorder shim
 * Provides MediaRecorder-compatible API using MediaBunny for encoding
 */
class BunnyRecorder extends EventTarget {
    constructor(stream, options = {}) {
        super();
        
        this.stream = stream;
        this.options = {
            mimeType: options.mimeType || 'video/mp4',
            videoBitsPerSecond: options.videoBitsPerSecond || QUALITY_HIGH,
            audioBitsPerSecond: options.audioBitsPerSecond || QUALITY_HIGH,
            ...options
        };
        
        // MediaRecorder states
        this.state = 'inactive';
        this.mimeType = this.options.mimeType;
        
        // Internal state
        this.output = null;
        this.videoSource = null;
        this.audioSource = null;
        this.canvas = null;
        this.video = null;
        this.audioContext = null;
        this.mediaStreamSource = null;
        this.audioWorkletNode = null;
        this.recordingStartTime = 0;
        this.animationFrame = null;
        this.chunks = [];
        
        // Event handlers (for compatibility)
        this.ondataavailable = null;
        this.onstart = null;
        this.onstop = null;
        this.onpause = null;
        this.onresume = null;
        this.onerror = null;
    }
    
    /**
     * Start recording
     * @param {number} timeslice - Optional timeslice for periodic data events
     */
    async start(timeslice) {
        if (this.state !== 'inactive') {
            throw new DOMException('Invalid state', 'InvalidStateError');
        }
        
        try {
            this.state = 'recording';
            this.recordingStartTime = Date.now();
            
            await this.#setupOutput();
            await this.#setupVideoCapture();
            await this.#setupAudioCapture();
            
            await this.output.start();
            this.#startFrameCapture();
            
            // Emit start event
            this.#dispatchEvent('start');
            
            // Handle timeslice if provided
            if (timeslice && timeslice > 0) {
                this.#setupTimeslice(timeslice);
            }
            
        } catch (error) {
            this.state = 'inactive';
            this.#dispatchEvent('error', { error });
            throw error;
        }
    }
    
    /**
     * Stop recording
     */
    async stop() {
        if (this.state === 'inactive') {
            return;
        }
        
        try {
            this.state = 'inactive';
            
            // Stop frame capture
            if (this.animationFrame) {
                cancelAnimationFrame(this.animationFrame);
                this.animationFrame = null;
            }
            
            // Finalize output
            if (this.output) {
                await this.output.finalize();
                const buffer = this.output.target.buffer;
                
                // Create blob and dispatch data event
                const blob = new Blob([buffer], { type: this.mimeType });
                this.#dispatchEvent('dataavailable', { data: blob });
            }
            
            // Cleanup resources
            this.#cleanup();
            
            // Emit stop event
            this.#dispatchEvent('stop');
            
        } catch (error) {
            this.#dispatchEvent('error', { error });
            throw error;
        }
    }
    
    /**
     * Pause recording
     */
    pause() {
        if (this.state !== 'recording') {
            return;
        }
        
        this.state = 'paused';
        
        // Pause frame capture
        if (this.animationFrame) {
            cancelAnimationFrame(this.animationFrame);
            this.animationFrame = null;
        }
        
        this.#dispatchEvent('pause');
    }
    
    /**
     * Resume recording
     */
    resume() {
        if (this.state !== 'paused') {
            return;
        }
        
        this.state = 'recording';
        this.#startFrameCapture();
        this.#dispatchEvent('resume');
    }
    
    /**
     * Request data (manual data event)
     */
    async requestData() {
        if (this.state === 'inactive') {
            return;
        }
        
        // For now, we'll just dispatch current state
        // In a full implementation, you might want to create intermediate chunks
        this.#dispatchEvent('dataavailable', { data: new Blob() });
    }
    
    /**
     * Setup MediaBunny output
     */
    async #setupOutput() {
        const format = this.#getOutputFormat();
        
        this.output = new Output({
            format,
            target: new BufferTarget(),
        });
    }
    
    /**
     * Setup video capture from MediaStream
     */
    async #setupVideoCapture() {
        const videoTracks = this.stream.getVideoTracks();
        if (videoTracks.length === 0) {
            return;
        }
        
        // Create canvas and video elements
        this.canvas = document.createElement('canvas');
        this.video = document.createElement('video');
        
        // Set canvas size (default or from track settings)
        const videoTrack = videoTracks[0];
        const settings = videoTrack.getSettings();
        this.canvas.width = settings.width || 640;
        this.canvas.height = settings.height || 480;
        
        // Setup video element
        this.video.srcObject = new MediaStream([videoTrack]);
        this.video.muted = true;
        this.video.playsInline = true;
        
        // Wait for video to be ready
        await new Promise((resolve, reject) => {
            this.video.onloadedmetadata = resolve;
            this.video.onerror = reject;
            this.video.play().catch(reject);
        });
        
        // Create video source for MediaBunny
        const codec = this.#getVideoCodec();
        this.videoSource = new CanvasSource(this.canvas, {
            codec,
            bitrate: this.options.videoBitsPerSecond,
        });
        
        this.output.addVideoTrack(this.videoSource);
    }
    
    /**
     * Setup audio capture from MediaStream
     */
    async #setupAudioCapture() {
        const audioTracks = this.stream.getAudioTracks();
        if (audioTracks.length === 0) {
            return;
        }
        
        // Create audio context and source
        this.audioContext = new AudioContext();
        this.mediaStreamSource = this.audioContext.createMediaStreamSource(
            new MediaStream(audioTracks)
        );
        
        // Create audio source for MediaBunny
        const codec = this.#getAudioCodec();
        this.audioSource = new AudioBufferSource({
            codec,
            bitrate: this.options.audioBitsPerSecond,
            sampleRate: this.audioContext.sampleRate,
        });
        
        this.output.addAudioTrack(this.audioSource);
        
        // Setup audio processing
        await this.#setupAudioProcessing();
    }
    
    /**
     * Setup audio processing pipeline
     */
    #setupAudioProcessing() {
        // Create a script processor for audio data
        const bufferSize = 4096;
        this.processor = this.audioContext.createScriptProcessor(bufferSize, 2, 2);
        
        this.processor.onaudioprocess = (event) => {
            if (this.state !== 'recording') {
                return;
            }
            
            const inputBuffer = event.inputBuffer;
            const channels = [];
            
            for (let i = 0; i < inputBuffer.numberOfChannels; i++) {
                channels.push(inputBuffer.getChannelData(i));
            }
            
            // Send audio data to MediaBunny
            // Note: This is a simplified approach
            // In practice, you'd need to properly format the audio data
            if (this.audioSource && channels.length > 0) {
                // AudioBufferSource expects specific format
                // This would need proper implementation based on MediaBunny's API
            }
        };
        
        // Connect audio processing chain
        this.mediaStreamSource.connect(this.processor);
        this.processor.connect(this.audioContext.destination);
    }
    
    /**
     * Start frame capture loop
     */
    #startFrameCapture() {
        if (!this.canvas || !this.video) {
            return;
        }
        
        const ctx = this.canvas.getContext('2d');
        
        const captureFrame = () => {
            if (this.state !== 'recording') {
                return;
            }
            
            // Draw video frame to canvas
            ctx.drawImage(this.video, 0, 0, this.canvas.width, this.canvas.height);
            
            // Schedule next frame
            this.animationFrame = requestAnimationFrame(captureFrame);
        };
        
        captureFrame();
    }
    
    /**
     * Setup timeslice-based data events
     */
    #setupTimeslice(timeslice) {
        const intervalId = setInterval(async () => {
            if (this.state === 'inactive') {
                clearInterval(intervalId);
                return;
            }
            
            // In a full implementation, you'd create intermediate chunks here
            this.#dispatchEvent('dataavailable', { data: new Blob() });
        }, timeslice);
    }
    
    /**
     * Get output format based on mimeType
     */
    #getOutputFormat() {
        const mimeType = this.mimeType.toLowerCase();
        
        if (mimeType.includes('webm')) {
            return new WebMOutputFormat();
        } else if (mimeType.includes('mp4')) {
            return new Mp4OutputFormat();
        } else {
            // Default to MP4
            return new Mp4OutputFormat();
        }
    }
    
    /**
     * Get video codec based on mimeType
     */
    #getVideoCodec() {
        const mimeType = this.mimeType.toLowerCase();
        
        if (mimeType.includes('av1')) {
            return 'av1';
        } else if (mimeType.includes('vp9')) {
            return 'vp9';
        } else if (mimeType.includes('vp8')) {
            return 'vp8';
        } else {
            return 'avc'; // H.264
        }
    }
    
    /**
     * Get audio codec based on mimeType
     */
    #getAudioCodec() {
        const mimeType = this.mimeType.toLowerCase();
        
        if (mimeType.includes('opus')) {
            return 'opus';
        } else if (mimeType.includes('vorbis')) {
            return 'vorbis';
        } else {
            return 'aac';
        }
    }
    
    /**
     * Dispatch events (both EventTarget and legacy handler style)
     */
    #dispatchEvent(type, data = {}) {
        const event = new CustomEvent(type, { detail: data });
        
        // Add data to event object for MediaRecorder compatibility
        if (data.data) {
            event.data = data.data;
        }
        if (data.error) {
            event.error = data.error;
        }
        
        // Dispatch using EventTarget
        this.dispatchEvent(event);
        
        // Call legacy handler if present
        const handlerName = `on${type}`;
        if (typeof this[handlerName] === 'function') {
            this[handlerName](event);
        }
    }
    
    /**
     * Cleanup resources
     */
    #cleanup() {
        if (this.audioWorkletNode) {
            this.audioWorkletNode.disconnect();
            this.audioWorkletNode = null;
        }
        
        if (this.mediaStreamSource) {
            this.mediaStreamSource.disconnect();
            this.mediaStreamSource = null;
        }
        
        if (this.audioContext) {
            this.audioContext.close();
            this.audioContext = null;
        }
        
        if (this.video) {
            this.video.srcObject = null;
            this.video = null;
        }
        
        this.canvas = null;
        this.output = null;
        this.videoSource = null;
        this.audioSource = null;
    }
    
    /**
     * Static method to check if a MIME type is supported
     */
    static isTypeSupported(mimeType) {
        const supportedTypes = [
            'video/mp4',
            'video/webm',
            'video/mp4; codecs="avc1.42E01E"',
            'video/mp4; codecs="av01.0.05M.08"',
            'video/webm; codecs="vp8"',
            'video/webm; codecs="vp9"',
            'video/webm; codecs="av01.0.05M.08"',
        ];
        
        return supportedTypes.some(type => 
            mimeType.toLowerCase().startsWith(type.toLowerCase())
        );
    }
}

// Export for use
export { BunnyRecorder };

// Usage example:
/*
// Replace native MediaRecorder with MediaBunnyRecorder
const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });

const recorder = new MediaBunnyRecorder(stream, {
    mimeType: 'video/mp4; codecs="avc1.42E01E"',
    videoBitsPerSecond: QUALITY_HIGH,
    audioBitsPerSecond: QUALITY_HIGH
});

recorder.ondataavailable = (event) => {
    if (event.data.size > 0) {
        // Handle recorded blob
        const url = URL.createObjectURL(event.data);
        // Download or use the recorded video
    }
};

recorder.onstop = () => {
    console.log('Recording stopped');
};

// Start recording
await recorder.start();

// Stop after 10 seconds
setTimeout(() => {
    recorder.stop();
}, 10000);
*/