# Speaker Sync

Play audio from a Chrome tab, a Windows app window, or the whole PC through the laptop and phones on the same Wi-Fi network. The laptop runs the relay and serves the website. The phones use their browsers. The server keeps room state in memory and forwards live PCM without storing audio or sending video.

## Deploy on Vercel

Vercel serves the website. A single Node.js service on Render handles rooms, WebSockets, QR codes, and the screen-off audio stream. Rooms live in the relay process, so keep the relay at one instance. Vercel Functions support WebSockets with a maximum connection duration, and separate connections may reach different instances.

1. Commit and push the app files to your GitHub repository. Include `render.yaml`, `vercel.json`, and the lockfile.
2. Choose the production domain you want on Vercel, such as `https://your-project.vercel.app`.
3. In the Render dashboard, choose **New → Blueprint** and connect the same GitHub repository. Render reads `render.yaml` and creates a Free Node web service. When asked for `FRONTEND_ORIGIN`, enter your production Vercel origin. Copy the generated HTTPS relay URL, such as `https://speaker-sync-relay.onrender.com`.
4. In Vercel, choose **Add New → Project**, import the repository, and use the **Other** framework preset with the repository root. Add `RELAY_ORIGIN` to the **Production** environment with the Render HTTPS URL, then deploy. The checked-in settings install with `npm ci`, build with `npm run build`, and publish `dist`.
5. Check the actual production domain in Vercel. If it differs from the one you chose, update `FRONTEND_ORIGIN` on Render and redeploy the relay. Each variable takes an origin, with no path.
6. Open the Render URL followed by `/healthz`. It should return `{"status":"ok","mode":"hosted"}`. Then open the production Vercel URL in desktop Chrome, create a room, scan its QR code on a phone, and tap **Listen**. Use **Play test click** to check the stream.

| Service | Variable | Example value |
| --- | --- | --- |
| Render relay | `FRONTEND_ORIGIN` | `https://your-project.vercel.app` |
| Vercel website | `RELAY_ORIGIN` | `https://speaker-sync-relay.onrender.com` |

The Render Free plan can take about a minute to wake after inactivity. Visit `/healthz` and wait for the response before opening a room if the relay is cold. The relay accepts requests from the exact Vercel origin you configure. Use the production domain for QR testing. A Vercel Preview deployment needs a relay configured for its preview origin. Rooms end when the host disconnects or the relay restarts.

## Start a room

1. On the Windows laptop, run the following in PowerShell from this folder. Use Node.js 22 or newer.

   ```powershell
   npm ci
   npm start
   ```

2. In the desktop Google Chrome app on Windows, open [http://localhost:3000](http://localhost:3000) and select **Create room**. Open the source audio in another Chrome tab. If the invitation uses the wrong network, expand **How to connect** in the room and choose the laptop’s Wi-Fi adapter.
3. Scan the QR code with the phone camera, or open the **join address** shown under the room code and type the code. Open the room in the phone browser (Safari on iPhone) and tap **Listen**. Keep the phone awake and the room in the foreground. Room codes expire when the host ends the room or the server restarts.
4. Select an audio source and click **Share audio**. In Chrome’s picker, turn on the audio option for that source.
   - **Chrome tab** uses scheduled playback on the laptop and phones. If the laptop stays silent, stop sharing, check **Keep original laptop audio**, and share the tab again.
   - **App window** uses Chrome’s **Window** picker and requires Chrome to offer app audio for the selected window.
   - **Whole PC** uses Chrome’s **Entire Screen** picker with system audio enabled.

   App window, Whole PC, and Keep original laptop audio use Windows’ normal playback. Phones still play the buffered stream, so the laptop can be ahead. Chrome requires a video track for capture. Speaker Sync uses it only to verify the selection and detect when sharing ends.
5. Use **Stop sharing** to return the tab to normal playback or **End room** to disconnect the phone.

The host shows **Sharing tab audio** once capture starts. **Laptop signal**, **Laptop playback**, and **Phone playback** in the diagnostics help you track where audio stops.

## Sound quality and screen-off listening

- **Listen** plays uncompressed stereo PCM and supports speaker routing and Auto Tune. If you hear crackles or the late-block count keeps rising, open **Playback settings and diagnostics** on the laptop and try a larger playback buffer. Local rooms start at 75 ms. Hosted rooms start at 350 ms to allow for the internet relay.
- Synced phone playback defaults to **+3 dB**. **Volume boost** adjusts this from 0 to +6 dB with peak limiting. The phone’s own media volume still applies.
- On iPhone, open the room in Safari and tap **Listen with screen off**. Wait until the stream is playing before locking the phone. This uses Safari’s native media player and a 192 kbps stereo MP3 stream, with the full mix and extra delay. Use ordinary **Listen** for Auto Tune and stereo speaker assignments. Keep the host room open.

## Speaker layout

In **Speakers**, assign each phone to **Copy**, **Left**, or **Right**. **Copy** plays the full stereo mix. **Left** and **Right** play only that channel through the assigned device. For a two-phone stereo setup, put the **Left** phone to your left and the **Right** phone to your right while facing both. Mono sources can sound the same on both sides. You can also assign the laptop when Speaker Sync controls its playback.

If **Play test click** works but shared tab audio is silent, try a Chrome tab with a known unprotected source. For diagnostics, expand **Playback settings and diagnostics**.

## Development

Stop the current server with Ctrl+C and run `npm run dev`. Nodemon watches `server.js` and the JavaScript, HTML, and CSS files in `public/`. Pages show **DEV MODE · AUTO-RELOAD** in the footer and refresh when the restarted server is ready. Rooms live in memory, so after a restart, create a new room and scan its new QR code.

The host runs on Chrome's secure loopback origin so capture and the AudioWorklet work. Phone playback uses Web Audio on the LAN URL in the QR. The prototype uses HTTP and unencrypted WebSockets on the local network. Use a trusted private Wi-Fi network and share the invitation only with intended listeners. If the phone cannot connect, verify that it is on the same Wi-Fi, that the access point allows devices to reach each other, and that Windows Firewall allows inbound TCP on port 3000 for the private network. If port 3000 is taken, set `$env:PORT = '3001'` before starting. Set `$env:LAN_HOST` to the laptop’s Wi-Fi IP before starting if automatic adapter selection points to the wrong address.

## Check speaker alignment

### Auto Tune

1. Open the host in desktop Chrome. Scan the QR on each phone and tap **Listen**.
2. Use the laptop speakers and place the phones where they'll play. Open **Auto Tune** on the host, click **Tune** next to a phone, and allow Chrome to use the laptop microphone.
3. The laptop and selected phone each play one short tone. The laptop identifies both tones locally. The room pauses program audio for the measurement and resumes it with the updated delays.
4. Repeat for each phone. When you tune another phone, Speaker Sync keeps the earlier measurements and recalculates all measured speakers' delays. A successful calibration resets manual Sync adjustments on the measured speakers. You can use the sliders afterward for fine adjustment.

Use Auto Tune with the room idle, the built-in test click, or synchronized Chrome tab playback. Windows controls the laptop output in **Whole PC**, **App window**, and **Keep original laptop audio**, so these modes can't apply a laptop tuning delay. Measurements belong to the current connection and room. Tune again after reconnecting or switching to a different speaker.

### Manual check

1. Start with the phone’s built-in speaker. Put both speakers near one another and use **Play test click** on the host. Each device should play one click per second.
2. Listen from roughly the same distance from both speakers. If you hear two hits, add delay using **Sync** on the device you hear first. Start with 5–10 ms steps and refine by ear. **Reset** returns that device to zero extra delay.
3. Listen again after several minutes. Record the device delay settings, how distinct the two hits sound, and whether the late-block count rises. For a measurement, record ten clicks with a third device and compare the two transients in the recording at the start and end.
4. Pair a Bluetooth speaker to the phone and repeat the alignment. Bluetooth output can add latency the browser cannot observe directly. If the phone speaker is later, add delay to the Windows speaker.
5. Try regular tab audio, then test Netflix separately. Protected playback can block capture or provide silence. Video remains on the source tab and is outside the audio sync target.

Playback uses a shared buffer plus any per-device calibration. The host’s AudioWorklet packages 10 ms stereo PCM blocks with a sequence number and source sample index. Devices estimate relay clock offset with repeated ping/pong exchanges, translate deadlines with Web Audio output timestamps where available, and use small playback-rate corrections to maintain continuity as clocks drift. A late block is dropped so stale audio cannot build up into a second delayed stream.

## Automated checks

Run `npm test`. The tests cover room and QR lifecycle, timestamp exchanges, PCM framing and forwarding, and drift correction. They do not measure the time sound leaves physical speakers.
