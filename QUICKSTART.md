# Quick Start Guide

Get the Desktop TikTok Player running in 5 minutes!

## 1️⃣ Install Node.js

Download from https://nodejs.org/ (LTS version recommended)

## 2️⃣ Configure Your Videos

Edit `config.js` in this folder and set your video path:

```javascript
// Set this to your video folder path:
const VIDEO_SOURCE_DIR = "C:\\Users\\YourName\\Videos\\categorized_videos";
```

Your folder structure should look something like:
```
categorized_videos/
  ├── Luxury/
  │   ├── video1.mp4
  │   └── video2.mp4
  └── Nature/
      └── clip.mp4
```

## 3️⃣ Install Dependencies

Open terminal in this folder and run:
```bash
npm install
```

## 4️⃣ Start the App

```bash
npm start
```

## 5️⃣ Open in Browser

Visit: **http://localhost:3000**

---

## ❓ Path Not Working?

Make sure your folder structure is correct:

✅ **CORRECT:**
```
Videos/
└── categorized_videos/
    └── Luxury/
        └── video.mp4
```

❌ **WRONG:**
```
Videos/
└── categorized_videos/
    └── video.mp4  (videos in root, not in category folder)
```

---

## 📁 File Organization Reference

| Path Type | Windows | macOS | Linux |
|-----------|---------|-------|-------|
| Videos | `C:\Users\Name\Videos\videos` | `/Users/Name/Videos/videos` | `/home/Name/Videos/videos` |
| Documents | `C:\Users\Name\Documents` | `/Users/Name/Documents` | `/home/Name/Documents` |
| Home | `C:\Users\Name` | `/Users/Name` | `/home/Name` |

---

## 🔧 Environment Variables (Advanced)

Instead of editing the file, you can set environment variables:

### PowerShell (Windows)
```powershell
$env:VIDEO_SOURCE_DIR = "C:\Users\YourName\Videos\videos"
npm start
```

### Terminal (macOS/Linux)
```bash
export VIDEO_SOURCE_DIR="/Users/YourName/Videos/videos"
npm start
```

---

## 📖 Need More Help?

- See **SETUP.md** for detailed setup instructions
- See **README.md** for full documentation
- Check **config.js** for configuration options

---

**Ready to go!** 🎬
