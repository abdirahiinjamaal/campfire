package main

import (
	"context"
	"crypto/rand"
	"embed"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io/fs"
	"log"
	"net/http"
	"os"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"
	"unicode"

	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"
	"github.com/skip2/go-qrcode"
)

const (
	bpm       = 120
	stepCount = 16
	loopMs    = 60_000 * 4 / bpm
	stepMs    = loopMs / stepCount
	leadMs    = 90
	maxRoom   = 32
)

//go:embed static
var embedded embed.FS

var codeRe = regexp.MustCompile(`^[A-Z0-9]{3,8}$`)

type clientMsg struct {
	Type string `json:"type"`
	Inst int    `json:"inst"`
	T0   int64  `json:"t0"`
}

type playerOut struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	Hue  int    `json:"hue"`
	Seq  int64  `json:"-"`
}

type noteOut struct {
	Type string `json:"type"`
	Inst int    `json:"inst"`
	At   int64  `json:"at"`
	By   string `json:"by"`
	Name string `json:"name"`
	Hue  int    `json:"hue"`
}

type client struct {
	id        string
	name      string
	hue       int
	seq       int64
	conn      *websocket.Conn
	send      chan []byte
	done      chan struct{}
	closeOnce sync.Once
}

func (c *client) close() {
	c.closeOnce.Do(func() {
		close(c.done)
		_ = c.conn.Close(websocket.StatusNormalClosure, "")
	})
}

func (c *client) trySendData(data []byte) {
	select {
	case c.send <- data:
	case <-c.done:
	default:
	}
}

func (c *client) trySend(v any) {
	data, err := json.Marshal(v)
	if err != nil {
		return
	}
	c.trySendData(data)
}

func (c *client) writeLoop() {
	for {
		select {
		case <-c.done:
			return
		case data := <-c.send:
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			err := c.conn.Write(ctx, websocket.MessageText, data)
			cancel()
			if err != nil {
				c.close()
				return
			}
		}
	}
}

type room struct {
	mu      sync.Mutex
	clients map[string]*client
	hueSeed float64
	seq     int64
}

func (r *room) players() []playerOut {
	r.mu.Lock()
	out := make([]playerOut, 0, len(r.clients))
	for _, c := range r.clients {
		out = append(out, playerOut{ID: c.id, Name: c.name, Hue: c.hue, Seq: c.seq})
	}
	r.mu.Unlock()
	sort.Slice(out, func(i, j int) bool { return out[i].Seq < out[j].Seq })
	return out
}

func (r *room) broadcast(v any) {
	data, err := json.Marshal(v)
	if err != nil {
		return
	}
	r.mu.Lock()
	subs := make([]*client, 0, len(r.clients))
	for _, c := range r.clients {
		subs = append(subs, c)
	}
	r.mu.Unlock()
	for _, c := range subs {
		c.trySendData(data)
	}
}

type hub struct {
	mu    sync.Mutex
	rooms map[string]*room
}

func (h *hub) add(roomID string, c *client) (*room, bool) {
	h.mu.Lock()
	defer h.mu.Unlock()
	r := h.rooms[roomID]
	if r == nil {
		r = &room{clients: make(map[string]*client), hueSeed: 12}
		h.rooms[roomID] = r
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if len(r.clients) >= maxRoom {
		return nil, false
	}
	r.seq++
	c.seq = r.seq
	c.hue = int(r.hueSeed) % 360
	r.hueSeed += 137.508
	r.clients[c.id] = c
	return r, true
}

func (h *hub) remove(roomID string, r *room, c *client) {
	c.close()
	r.mu.Lock()
	delete(r.clients, c.id)
	empty := len(r.clients) == 0
	r.mu.Unlock()

	if empty {
		h.mu.Lock()
		if h.rooms[roomID] == r {
			r.mu.Lock()
			still := len(r.clients) == 0
			r.mu.Unlock()
			if still {
				delete(h.rooms, roomID)
			}
		}
		h.mu.Unlock()
	}
	r.broadcast(map[string]any{"type": "players", "players": r.players()})
}

func nextSlot(now int64) int64 {
	base := now + leadMs
	rem := base % stepMs
	if rem == 0 {
		return base
	}
	return base - rem + stepMs
}

func newID() string {
	var b [4]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "anon"
	}
	return hex.EncodeToString(b[:])
}

func cleanName(s string) string {
	s = strings.TrimSpace(s)
	var b strings.Builder
	n := 0
	for _, r := range s {
		if n >= 16 {
			break
		}
		if unicode.IsControl(r) {
			continue
		}
		b.WriteRune(r)
		n++
	}
	out := strings.TrimSpace(b.String())
	if out == "" {
		return "guest"
	}
	return out
}

func handleWS(h *hub, w http.ResponseWriter, r *http.Request) {
	roomID := strings.ToUpper(strings.TrimSpace(r.URL.Query().Get("room")))
	if !codeRe.MatchString(roomID) {
		http.Error(w, "invalid room code", http.StatusBadRequest)
		return
	}
	name := cleanName(r.URL.Query().Get("name"))

	conn, err := websocket.Accept(w, r, nil)
	if err != nil {
		return
	}
	conn.SetReadLimit(4096)

	c := &client{
		id:   newID(),
		name: name,
		conn: conn,
		send: make(chan []byte, 64),
		done: make(chan struct{}),
	}
	rm, ok := h.add(roomID, c)
	if !ok {
		_ = conn.Close(websocket.StatusTryAgainLater, "room is full")
		return
	}
	defer h.remove(roomID, rm, c)
	go c.writeLoop()

	c.trySend(map[string]any{
		"type":    "welcome",
		"id":      c.id,
		"name":    c.name,
		"hue":     c.hue,
		"bpm":     bpm,
		"steps":   stepCount,
		"loopMs":  loopMs,
		"stepMs":  stepMs,
		"players": rm.players(),
	})
	rm.broadcast(map[string]any{"type": "players", "players": rm.players()})

	var hits int
	winStart := time.Now()
	for {
		ctx, cancel := context.WithTimeout(context.Background(), 75*time.Second)
		var m clientMsg
		err := wsjson.Read(ctx, conn, &m)
		cancel()
		if err != nil {
			return
		}

		now := time.Now()
		switch m.Type {
		case "ping":
			c.trySend(map[string]any{"type": "pong", "t0": m.T0, "t1": time.Now().UnixMilli()})
		case "hit":
			if m.Inst < 0 || m.Inst >= 6 {
				continue
			}
			if now.Sub(winStart) > time.Second {
				winStart = now
				hits = 0
			}
			if hits >= 14 {
				continue
			}
			hits++
			at := nextSlot(now.UnixMilli())
			rm.broadcast(noteOut{
				Type: "note",
				Inst: m.Inst,
				At:   at,
				By:   c.id,
				Name: c.name,
				Hue:  c.hue,
			})
		}
	}
}

func serveHTML(w http.ResponseWriter, name string) {
	data, err := embedded.ReadFile("static/" + name)
	if err != nil {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	_, _ = w.Write(data)
}

func handleQR(w http.ResponseWriter, r *http.Request) {
	d := r.URL.Query().Get("d")
	if d == "" || len(d) > 512 {
		http.Error(w, "bad data", http.StatusBadRequest)
		return
	}
	png, err := qrcode.Encode(d, qrcode.Medium, 320)
	if err != nil {
		http.Error(w, "qr error", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "image/png")
	w.Header().Set("Cache-Control", "public, max-age=3600")
	_, _ = w.Write(png)
}

func main() {
	addr := os.Getenv("ADDR")
	if addr == "" {
		port := os.Getenv("PORT")
		if port == "" {
			port = "8080"
		}
		addr = ":" + port
	}

	sub, err := fs.Sub(embedded, "static")
	if err != nil {
		log.Fatal(err)
	}

	h := &hub{rooms: make(map[string]*room)}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /{$}", func(w http.ResponseWriter, r *http.Request) {
		serveHTML(w, "index.html")
	})
	mux.HandleFunc("GET /r/{code}", func(w http.ResponseWriter, r *http.Request) {
		if !codeRe.MatchString(strings.ToUpper(r.PathValue("code"))) {
			http.Redirect(w, r, "/", http.StatusFound)
			return
		}
		serveHTML(w, "room.html")
	})
	mux.HandleFunc("GET /ws", func(w http.ResponseWriter, r *http.Request) {
		handleWS(h, w, r)
	})
	mux.HandleFunc("GET /qr", handleQR)
	mux.Handle("GET /static/", http.StripPrefix("/static/", http.FileServerFS(sub)))

	srv := &http.Server{
		Addr:              addr,
		Handler:           mux,
		ReadHeaderTimeout: 5 * time.Second,
	}
	log.Printf("campfire listening on %s", addr)
	if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Fatal(err)
	}
}
