# Speaker Sync

Play audio from a Chrome tab, a Windows app window, or the whole PC through the laptop and phones on the same Wi-Fi network. The laptop runs the relay and serves the website. The phones use their browsers. The server keeps room state in memory and forwards live PCM without storing audio or sending video.

## Deploy on Vercel

Vercel serves the website. A single persistent Node.js relay handles rooms and streams audio over secure WebSockets. A room uses the same relay process for the laptop, phones, QR codes, and code lookup. Vercel Functions can route separate connections to different instances and close them when they reach the function duration limit.

1. Choose the production Vercel project name and its HTTPS URL. You can also use a custom HTTPS domain.
2. Deploy this repo to a Node.js host that supports long-lived WebSockets. Use Node.js 22 or newer, run `npm ci` and `npm start`, and keep one relay instance. Set `FRONTEND_ORIGIN` to the exact production Vercel origin, for example `https://speaker-sync.vercel.app`. The hosting service should forward HTTPS and WSS traffic to the application's `PORT` and can use `/` as a health check.
3. Import the GitHub repo into Vercel. Keep the repository root and use the **Other** framework preset. The checked-in configuration runs the build and serves `dist`.
4. Set Vercel's Production environment variable `RELAY_ORIGIN` to the relay's public HTTPS origin, for example `https://relay.example.com`. Deploy after setting it. Both origin variables take an origin without a path.
5. Open the production URL in desktop Chrome, select **Create room**, scan the QR code with a phone, and tap **Listen**. Use **Play test click** to check the stream.

The relay accepts browser WebSockets from the exact configured frontend origin. Use that URL when testing. To use a Vercel preview URL, configure a separate relay with that preview origin. Rooms end when the host disconnects or the relay restarts.

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

The host shows **Sharing tab audio** once the capture starts. **Laptop signal** shows whether the source contains sound. **Laptop playback** and **Phone playback** show when each browser receives data and schedules sound. If both devices are silent, start with **Laptop signal**. If the phone reports **Sound scheduled** and you hear nothing, check the iPhone’s media volume and output device.

## Speaker layout

In **Speakers**, assign each phone to **Copy**, **Left**, or **Right**. **Copy** plays the full stereo mix. **Left** and **Right** play only that channel through the assigned device. For a two-phone stereo setup, put the **Left** phone to your left and the **Right** phone to your right while facing both. Mono sources can sound the same on both sides. You can also assign the laptop when Speaker Sync controls its playback.

If the room plays **Play test click** but tab audio is silent, use **Open test audio in a separate tab** and press **Play click** in that tab. Then share that tab through the Chrome picker. If the test tab works and another tab shows **Silent input**, check that the other tab is playing and try an unprotected source.

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

Playback uses a 75 ms shared buffer plus any per-device calibration. The host’s AudioWorklet packages 10 ms stereo PCM blocks with a sequence number and source sample index. Devices estimate relay clock offset with repeated ping/pong exchanges, translate deadlines with Web Audio output timestamps where available, and use small playback-rate corrections to maintain continuity as clocks drift. A late block is dropped so stale audio cannot build up into a second delayed stream.

## Automated checks

Run `npm test`. The tests cover room and QR lifecycle, timestamp exchanges, PCM framing and forwarding, and drift correction. They do not measure the time sound leaves physical speakers.
