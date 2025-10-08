const express = require("express");
const app = express();

app.use(express.json());

app.get("/data", (req, res) => {
    res.send("Hello !");
});

const PORT = 5000;

app.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
});
