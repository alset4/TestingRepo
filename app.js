const twilio = require('twilio');
const WebSocket = require('ws');
const http = require('http');
const { v4: uuidv4 } = require('uuid');  // cartesia requires a context_id wtv that means

// Directly set environment variables in the script -> havent done this yet bc was throwing a .env error
const TWILIO_ACCOUNT_SID = 'AC7bcdb36d771cf35a099be3848e936071';
const TWILIO_AUTH_TOKEN = 'b9126b2edfedc72268417a45c0d18393';
const CARTESIA_API_KEY = '99ecf97e-e04b-4fac-b4ee-b6c1220036e2';

const config = {
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  CARTESIA_API_KEY,
};

const client = twilio(config.TWILIO_ACCOUNT_SID, config.TWILIO_AUTH_TOKEN);
const TTS_WEBSOCKET_URL = `wss://api.cartesia.ai/tts/websocket?api_key=${config.CARTESIA_API_KEY}&cartesia_version=2024-06-10`;

const modelId = 'sonic-english';
const voice = {
  'mode': 'id',
  'id': "dbe95687-c003-4a95-87c8-20266800e89f" // Michelle obama
};

//currently set up for outbounding for testing
const partialResponse = "Hello, my name is Luna, Ill be your AI assistant for the day, daddy.";
const outbound = "+14124036326"; // Replace with the number you want to call
const inbound = "+14129395606";  // Replace with your Twilio number

let ttsWebSocket;
let callSid;
let audioChunksReceived = 100;
let messageComplete = false;

// Create a unique context ID for the session
const contextId = uuidv4();  // Unique context ID for this conversation

function log(message) {
  console.log(`[LOG] ${message}`);
}

// Create WebSocket connection to TTS service (Cartesia)
function connectToTTSWebSocket() {
  return new Promise((resolve, reject) => {
    log('Attempting to connect to TTS WebSocket');
    ttsWebSocket = new WebSocket(TTS_WEBSOCKET_URL);

    ttsWebSocket.on('open', () => {
      log('Connected to TTS WebSocket');
      resolve(ttsWebSocket);
    });

    ttsWebSocket.on('error', (error) => {
      log(`TTS WebSocket error: ${error.message}`);
      reject(error);
    });

    ttsWebSocket.on('close', (code, reason) => {
      log(`TTS WebSocket closed. Code: ${code}, Reason: ${reason}`);
      reject(new Error('TTS WebSocket closed unexpectedly'));
    });
  });
}

function sendTTSMessage(message) {
  const textMessage = {
    'model_id': modelId,
    'transcript': message,
    'voice': voice,
    'output_format': {
      'container': 'raw',
      'encoding': 'pcm_mulaw',
      'sample_rate': 8000
    },
    'context_id': contextId  // Include the context ID
  };

  log(`Sending message to TTS WebSocket: ${message}`);
  ttsWebSocket.send(JSON.stringify(textMessage));
}

function testTTSWebSocket() {
  return new Promise((resolve, reject) => {
    const testMessage = 'This is a test message';
    let receivedAudio = false;

    sendTTSMessage(testMessage);

    const timeout = setTimeout(() => {
      if (!receivedAudio) {
        reject(new Error('Timeout: No audio received from TTS WebSocket'));
      }
    }, 10000); // 10 second timeout

    ttsWebSocket.on('message', (audioChunk) => {
      if (!receivedAudio) {
        log(audioChunk);
        log('Received audio chunk from TTS for test message');
        receivedAudio = true;
        clearTimeout(timeout);
        resolve();
      }
    });
  });
}

async function startCall(twilioWebsocketUrl) {
  try {
    log(`Initiating call with WebSocket URL: ${twilioWebsocketUrl}`);
    const call = await client.calls.create({
      twiml: `<Response><Connect><Stream url="${twilioWebsocketUrl}"/></Connect></Response>`,
      to: outbound,  // Replace with the phone number you want to call
      from: inbound  // Replace with your Twilio phone number
    });

    callSid = call.sid;
    log(`Call initiated. SID: ${callSid}`);
  } catch (error) {
    log(`Error initiating call: ${error.message}`);
    throw error;
  }
}

async function hangupCall() {
  try {
    log(`Attempting to hang up call: ${callSid}`);
    await client.calls(callSid).update({status: 'completed'});
    log('Call hung up successfully');
  } catch (error) {
    log(`Error hanging up call: ${error.message}`);
  }
}

// Set up WebSocket server for Twilio
async function setupTwilioWebSocket() {
  const server = http.createServer((req, res) => {
    log(`Received HTTP request: ${req.method} ${req.url}`);
    res.writeHead(200);
    res.end('WebSocket server is running');
  });

  const wss = new WebSocket.Server({ server });

  log('WebSocket server created');

  wss.on('connection', (twilioWs, request) => {
    log(`Twilio WebSocket connection attempt from ${request.socket.remoteAddress}`);

    let streamSid = null;

    twilioWs.on('message', (message) => {
      try {
        const msg = JSON.parse(message);
        log(`Received message from Twilio: ${JSON.stringify(msg)}`);

        if (msg.event === 'start') {
          log('Media stream started');
          streamSid = msg.start.streamSid;
          log(`Stream SID: ${streamSid}`);
          sendTTSMessage(partialResponse);
        } else if (msg.event === 'media' && !messageComplete) {
          log('Received media event');
        } else if (msg.event === 'stop') {
          log('Media stream stopped');
          hangupCall();
        }
      } catch (error) {
        log(`Error processing Twilio message: ${error.message}`);
      }
    });

    twilioWs.on('close', (code, reason) => {
      log(`Twilio WebSocket disconnected. Code: ${code}, Reason: ${reason}`);
    });

    twilioWs.on('error', (error) => {
      log(`Twilio WebSocket error: ${error.message}`);
    });

    ttsWebSocket.on('message', (audioChunk) => {
      log('Received audio chunk from TTS');
      try {
        if (streamSid) {
          const messageToSend = {
            event: 'media',
            streamSid: streamSid,
            media: {
              payload: JSON.parse(audioChunk)['data']
            }
          };
          log('Sending message to Twilio WebSocket:', JSON.stringify(messageToSend));

          twilioWs.send(JSON.stringify(messageToSend));

          audioChunksReceived++;
          log(`Audio chunks received: ${audioChunksReceived}`);

          if (audioChunksReceived >= 50) {
            messageComplete = true;
            log('Message complete, preparing to hang up');
            setTimeout(hangupCall, 2000);
          }
        } else {
          log('Warning: Received audio chunk but streamSid is not set');
        }
      } catch (error) {
        log(`Error sending audio chunk to Twilio: ${error.message}`);
      }
    });

    log('Twilio WebSocket connected and handlers set up');
  });

  server.listen(0, () => {
    const port = server.address().port;
    log(`Twilio WebSocket server is running on port ${port}`);
    return port;
  });
}

//Theoretically wont need this on webserver
// Replace Ngrok with our WebSocket API Gateway URL
async function setupAWSWebSocket() {
  const twilioWebsocketUrl = 'add azure websocket here';
  log(`WebSocket URL: ${twilioWebsocketUrl}`);
  return twilioWebsocketUrl;
}

async function main() {
  try {
    log('Starting application');

    await connectToTTSWebSocket();
    log('TTS WebSocket connected');

    await testTTSWebSocket();
    log('TTS WebSocket test passed');

    const twilioWebSocketUrl = await setupAWSWebSocket();
    log(`Twilio WebSocket URL is ${twilioWebSocketUrl}`);

    await setupTwilioWebSocket();

    await startCall(twilioWebSocketUrl);
  } catch (error) {
    log(`Error: ${error.message}`);
  }
}

main().catch((error) => {
  console.error('Application error:', error);
});
