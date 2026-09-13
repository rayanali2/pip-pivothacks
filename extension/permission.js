// Grants microphone access to the extension's origin; the side panel then records without a prompt.
const status = document.getElementById('status');
const button = document.getElementById('allow');

async function ask() {
  button.disabled = true;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((track) => track.stop());
    status.textContent = 'Microphone ready. Go back to Pip and hold the button to talk. This tab closes in a moment.';
    button.hidden = true;
    setTimeout(() => window.close(), 2200);
  } catch {
    status.textContent = 'Microphone access is off. Allow it from the icon in the address bar, or type your day instead.';
    button.disabled = false;
  }
}

button.addEventListener('click', ask);
ask();
