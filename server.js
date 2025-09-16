const express = require('express');
const fs = require('fs');
const path = require('path');
const bodyParser = require('body-parser');

const app = express();
const PORT = process.env.PORT || 3000;

const http = require('http').createServer(app);
const io = require('socket.io')(http);

const userCounts = {}; // Track connected users per topic

io.on('connection', (socket) => {
  console.log('🔗 A client connected:', socket.id);
  let joinedTopic = null;

  socket.on('joinTopic', (topic) => {
    if (joinedTopic) {
      socket.leave(joinedTopic);
      if (userCounts[joinedTopic]) {
        userCounts[joinedTopic] = Math.max(0, userCounts[joinedTopic] - 1);
        io.to(joinedTopic).emit('userCountUpdate', userCounts[joinedTopic]);
      }
    }
    joinedTopic = topic;
    socket.join(joinedTopic);
    userCounts[joinedTopic] = (userCounts[joinedTopic] || 0) + 1;
    io.to(joinedTopic).emit('userCountUpdate', userCounts[joinedTopic]);
    console.log(`Client ${socket.id} joined topic ${joinedTopic}. Users: ${userCounts[joinedTopic]}`);
  });

  socket.on('disconnect', () => {
    if (joinedTopic && userCounts[joinedTopic]) {
      userCounts[joinedTopic] = Math.max(0, userCounts[joinedTopic] - 1);
      io.to(joinedTopic).emit('userCountUpdate', userCounts[joinedTopic]);
      console.log(`Client ${socket.id} disconnected. Users in ${joinedTopic}: ${userCounts[joinedTopic]}`);
    }
  });
});


// Middleware
app.use(bodyParser.json());
app.use(express.static(__dirname));

// Folders for storage
const saveDir = path.join(__dirname, 'saved_messages');
const stateDir = path.join(__dirname, 'user_states');

if (!fs.existsSync(saveDir)) {
  fs.mkdirSync(saveDir);
}

if (!fs.existsSync(stateDir)) {
  fs.mkdirSync(stateDir);
}

// ENHANCED: CSV parsing function from server2.js
function parseCSVLine(line) {
  const result = [];
  let current = '';
  let inQuotes = false;
  let i = 0;
  
  while (i < line.length) {
    const char = line[i];
    const nextChar = line[i + 1];
    
    if (char === '"' && inQuotes && nextChar === '"') {
      // Escaped quote
      current += '"';
      i += 2;
    } else if (char === '"') {
      inQuotes = !inQuotes;
      i++;
    } else if (char === ',' && !inQuotes) {
      result.push(current.trim());
      current = '';
      i++;
    } else {
      current += char;
      i++;
    }
  }
  
  if (current) {
    result.push(current.trim());
  }
  
  return result;
}

// ENHANCED: Message retrieval function for specific topics
function getMessagesForTopic(topic, limit = 10) {
  try {
    const messages = [];
    const files = fs.readdirSync(saveDir).filter(file => file.endsWith('.csv'));
    
    console.log(`📥 Loading messages for topic: ${topic} from ${files.length} files`);
    
    for (const file of files) {
      const filePath = path.join(saveDir, file);
      const content = fs.readFileSync(filePath, 'utf8');
      const lines = content.split('\n').slice(1); // Skip header
      
      for (const line of lines) {
        if (line.trim()) {
          try {
            const fields = parseCSVLine(line);
            
            if (fields.length >= 4 && fields[1] === topic) {
              const message = {
                timestamp: fields[0],
                topic: fields[1],
                username: fields[2],
                message: fields[3],
                sender: fields[2]
              };
              messages.push(message);
            }
          } catch (parseError) {
            console.warn(`Error parsing line: ${line}`, parseError);
          }
        }
      }
    }
    
    // Sort by timestamp and return last N messages
    const sortedMessages = messages
      .sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp))
      .slice(-limit);
      
    console.log(`✅ Returning ${sortedMessages.length} messages for topic ${topic}`);
    return sortedMessages;
      
  } catch (error) {
    console.error('❌ Error reading messages for topic:', error);
    return [];
  }
}

// NEW: Get messages for a specific topic
app.get('/messages/:topic', (req, res) => {
  try {
    const topic = req.params.topic;
    const limit = parseInt(req.query.limit) || 10;
    
    console.log(`🔍 API request for topic: ${topic}, limit: ${limit}`);
    const messages = getMessagesForTopic(topic, limit);
    
    res.json({ 
      success: true, 
      messages, 
      topic,
      count: messages.length 
    });
    
  } catch (error) {
    console.error('❌ Error fetching topic messages:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ENHANCED: Save message API with better CSV handling
app.post('/save', (req, res) => {
  try {
    const { timestamp, topic, payload, username, sender } = req.body;
    
    console.log(`💾 Saving message: ${username} -> ${topic}: ${payload}`);
    
    // Create separate CSV file for each user
    const fileName = `${username}_messages.csv`;
    const filePath = path.join(saveDir, fileName);
    
    // Prepare CSV line with proper escaping
    const safePayload = String(payload || '').replace(/"/g, '""');
    const safeUsername = String(username || '').replace(/"/g, '""');
    const safeTopic = String(topic || '').replace(/"/g, '""');
    const safeSender = String(sender || username || '').replace(/"/g, '""');
    
    const line = `${timestamp},"${safeTopic}","${safeSender}","${safePayload}"\n`;
    
    // Write header if file doesn't exist
    if (!fs.existsSync(filePath)) {
      const header = 'Timestamp,Topic,Sender,Message\n';
      fs.writeFileSync(filePath, header);
      console.log(`📄 Created new file: ${fileName}`);
    }
    
    // Append the message
    fs.appendFileSync(filePath, line);
    
    console.log(`✅ Message saved successfully for ${username}`);
    res.json({ success: true, message: 'Message saved successfully' });
    
  } catch (error) {
    console.error('❌ Error saving message:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// NEW: Save user component states
app.post('/save-state', (req, res) => {
  try {
    const { username, buttonState, switchState, indicatorValue } = req.body;
    
    console.log(`🎛️ Saving state for ${username}: Button=${buttonState}, Switch=${switchState}, Indicator=${indicatorValue}`);
    
    const stateFile = path.join(stateDir, `${username}_state.json`);
    const stateData = {
      username,
      buttonState: buttonState || 'OFF',
      switchState: switchState || false,
      indicatorValue: indicatorValue || '000',
      lastUpdated: new Date().toISOString()
    };
    
    fs.writeFileSync(stateFile, JSON.stringify(stateData, null, 2));
    
    console.log(`✅ State saved for ${username}`);
    res.json({ success: true, message: 'State saved successfully' });
    
  } catch (error) {
    console.error('❌ Error saving state:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// NEW: Load user component states
app.get('/load-state/:username', (req, res) => {
  try {
    const username = req.params.username;
    const stateFile = path.join(stateDir, `${username}_state.json`);
    
    if (fs.existsSync(stateFile)) {
      const stateData = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      console.log(`📤 Loaded state for ${username}:`, stateData);
      res.json({ success: true, state: stateData });
    } else {
      // Return default state if no saved state exists
      const defaultState = {
        username,
        buttonState: 'OFF',
        switchState: false,
        indicatorValue: '000'
      };
      console.log(`📋 Using default state for ${username}`);
      res.json({ success: true, state: defaultState });
    }
    
  } catch (error) {
    console.error('❌ Error loading state:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// NEW: Debug endpoint
app.get('/debug/messages/:topic', (req, res) => {
  try {
    const topic = req.params.topic;
    const messages = getMessagesForTopic(topic, 50);
    
    res.json({
      topic,
      messageCount: messages.length,
      messages: messages.map(m => ({
        time: new Date(m.timestamp).toLocaleString(),
        user: m.username,
        msg: m.message
      }))
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Existing endpoints
app.get('/health', (req, res) => {
  res.json({ 
    status: 'OK', 
    timestamp: new Date().toISOString(),
    message: 'Server is running'
  });
});

app.get('/messages', (req, res) => {
  try {
    const files = fs.readdirSync(saveDir)
      .filter(file => file.endsWith('.csv'))
      .map(file => ({
        filename: file,
        path: `/saved_messages/${file}`,
        size: fs.statSync(path.join(saveDir, file)).size,
        modified: fs.statSync(path.join(saveDir, file)).mtime
      }));
    
    res.json({ files });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.use('/saved_messages', express.static(saveDir));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Error handling
app.use((err, req, res, next) => {
  console.error('Server error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// Start server
http.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Teslacare MQTT Server running at http://localhost:${PORT}`);
  console.log(`📁 Messages will be saved to: ${saveDir}`);
  console.log(`🎛️ User states will be saved to: ${stateDir}`);
  console.log(`🔗 Health check: http://localhost:${PORT}/health`);
  console.log(`📋 View saved messages: http://localhost:${PORT}/messages`);
  console.log(`🐛 Debug messages: http://localhost:${PORT}/debug/messages/TOPIC_NAME`);
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n🛑 Server shutting down gracefully...');
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('\n🛑 Server shutting down gracefully...');
  process.exit(0);
});
