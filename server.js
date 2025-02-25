import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import connectDB from './db.js'; // MongoDB connection
import Room from './rooms.js'; // Room model
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
connectDB();

const server = http.createServer(app);
const io = new Server(server); // Initialize socket.io on the server

// Middleware to parse JSON
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Route to fetch room details
app.get('/getRoomDetails', async (req, res) => {
    const { room } = req.query; // Get room code from query parameters

    if (!room) {
        return res.status(400).json({ success: false, error: 'Room code is required' });
    }

    try {
        const roomDetails = await Room.findOne({ roomCode: room }); // Find room in the database
        if (!roomDetails) {
            return res.status(404).json({ success: false, error: 'Room not found' });
        }

        // Return room details
        res.status(200).json({
            success: true,
            roomCode: roomDetails.roomCode,
            players: roomDetails.players, // Array of players with names and characters
        });
    } catch (error) {
        console.error('Error fetching room details:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// Route to start the game
app.post('/startGame', async (req, res) => {
    const { room, mode } = req.body; // Destructure room and mode from the request body

    if (!room || !mode) {
        return res.status(400).json({ success: false, error: 'Room code and mode are required' });
    }

    try {
        console.log('Received startGame request for room:', room, 'with mode:', mode); // Log the room and mode

        const roomDetails = await Room.findOne({ roomCode: room });
        if (!roomDetails) {
            return res.status(404).json({ success: false, error: 'Room not found' });
        }

        // Update the room with the selected mode and set status to 'prompt'
        roomDetails.mode = mode;
        roomDetails.status = 'prompt';
        await roomDetails.save();

        // Notify all players to navigate to the prompt page
        io.to(room).emit('startGame', { mode });
        res.status(200).json({ success: true });
    } catch (error) {
        console.error('Error starting game:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// Route to submit a prompt
app.post('/submitPrompt', async (req, res) => {
    const { room, prompt } = req.body;

    if (!room || !prompt) {
        return res.status(400).json({ success: false, error: 'Room code and prompt are required' });
    }

    try {
        const roomDetails = await Room.findOne({ roomCode: room });
        if (!roomDetails) {
            return res.status(404).json({ success: false, error: 'Room not found' });
        }

        // Add the prompt to the room
        roomDetails.prompts.push(prompt);
        await roomDetails.save();

        res.status(200).json({ success: true });
    } catch (error) {
        console.error('Error submitting prompt:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// Route to get a random prompt
app.get('/getRandomPrompt', async (req, res) => {
    const { room } = req.query;

    if (!room) {
        return res.status(400).json({ success: false, error: 'Room code is required' });
    }

    try {
        const roomDetails = await Room.findOne({ roomCode: room });
        if (!roomDetails) {
            return res.status(404).json({ success: false, error: 'Room not found' });
        }

        // Get a random prompt from the list
        const prompts = roomDetails.prompts || [];
        if (prompts.length === 0) {
            return res.status(404).json({ success: false, error: 'No prompts available' });
        }

        const randomPrompt = prompts[Math.floor(Math.random() * prompts.length)];

        // Update the current prompt and set status to 'drawing'
        roomDetails.currentPrompt = randomPrompt;
        roomDetails.status = 'drawing';
        await roomDetails.save();

        res.status(200).json({ success: true, prompt: randomPrompt });
    } catch (error) {
        console.error('Error fetching prompt:', error);
        res.status(500).json({ success: false, error: 'Internal server error' });
    }
});

// Set up socket.io event listeners
io.on('connection', (socket) => {
    console.log('A user connected');

    socket.on('createRoom', async (data) => {
        const { playerName, roomCode, selectedCharacter, selectedCharacterImage } = data;

        // Check if the room already exists
        const existingRoom = await Room.findOne({ roomCode });
        if (existingRoom) {
            socket.emit('roomError', 'Room code already exists!');
            return;
        }

        // Create a new room
        const newRoom = new Room({
            roomCode,
            players: [{ name: playerName, character: selectedCharacter, characterImage: selectedCharacterImage }],
        });

        try {
            await newRoom.save();
            // Emit the roomCreated event with the room details
            socket.emit('roomCreated', newRoom);
            socket.join(roomCode); 
        } catch (error) {
            console.error('Error creating room:', error);
            socket.emit('roomError', 'Error creating room!');
        }
    });

    socket.on('joinRoom', async ({ roomCode, playerName, selectedCharacter, selectedCharacterImage }) => {
        if (!roomCode || !playerName || !selectedCharacter || !selectedCharacterImage) {
            socket.emit('roomError', 'Room code, player name, character, and character image are required!');
            return;
        }

        const room = await Room.findOne({ roomCode });
        if (!room) {
            socket.emit('roomError', 'Room does not exist!');
            return;
        }

        if (room.players.some(player => player.name === playerName)) {
            socket.emit('roomError', 'Player already in room!');
            return;
        }

        // Add the player and their selected character to the room
        room.players.push({ name: playerName, character: selectedCharacter, characterImage: selectedCharacterImage });
        await room.save();

        socket.emit('roomJoined', room);
        socket.join(roomCode); // Join the room
    });

    // Handle player disconnection
    socket.on('disconnect', async () => {
        console.log('A user disconnected');

        // Find the room the player was in
        const rooms = await Room.find({});
        for (const room of rooms) {
            const playerIndex = room.players.findIndex(player => player.name === socket.playerName);
            if (playerIndex !== -1) {
                // Remove the player from the room
                room.players.splice(playerIndex, 1);
                await room.save();

                // Notify other players in the room that a player has left
                io.to(room.roomCode).emit('playerLeft', { playerName: socket.playerName });

                // If the room is empty, delete it
                if (room.players.length === 0) {
                    await Room.deleteOne({ roomCode: room.roomCode });
                    console.log(`Room ${room.roomCode} deleted because it is empty.`);
                }

                break;
            }
        }
    });
});

// Serve static files if you're using Express to serve them
app.use(express.static('public')); // Assuming you have your HTML files in the 'public' folder

// Start the server
const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});