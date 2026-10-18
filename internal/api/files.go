package api

import (
	"errors"
	"io"
	"mime"
	"net/http"
	"slices"
	"strconv"
	"time"

	"github.com/thiagodefreitas/faztudo/internal/domain"
	"github.com/thiagodefreitas/faztudo/internal/events"
	"github.com/thiagodefreitas/faztudo/internal/files"
)

const (
	defaultMaxUpload   = 25 << 20
	maxAttachments     = 10
	multipartOverhead  = 1 << 20
	maxSearchQueryLen  = 200
	servedFileCacheTTL = "private, max-age=31536000, immutable"
)

func (a *API) maxUpload() int64 {
	if a.MaxUploadBytes > 0 {
		return a.MaxUploadBytes
	}
	return defaultMaxUpload
}

// upload stores one file from a multipart form field named "file" and returns
// its description. The file is not tied to a message until one names it.
func (a *API) upload(w http.ResponseWriter, r *http.Request) {
	if !humanOnly(w, r, "upload files") {
		return
	}
	if a.FilesDir == "" {
		fail(w, 503, "unavailable", "file uploads are not configured")
		return
	}
	limit := a.maxUpload()
	r.Body = http.MaxBytesReader(w, r.Body, limit+multipartOverhead)
	mr, err := r.MultipartReader()
	if err != nil {
		fail(w, 400, "bad_request", "multipart/form-data required")
		return
	}
	for {
		part, err := mr.NextPart()
		if errors.Is(err, io.EOF) {
			fail(w, 400, "bad_request", "form field \"file\" required")
			return
		}
		if err != nil {
			uploadError(w, err)
			return
		}
		if part.FormName() != "file" {
			continue
		}
		name := files.CleanName(part.FileName())
		id, size, err := files.Store{Dir: a.FilesDir}.Put(part, limit)
		if err != nil {
			uploadError(w, err)
			return
		}
		typ, _, err := files.Store{Dir: a.FilesDir}.Info(id)
		if err != nil {
			failErr(w, err)
			return
		}
		respond(w, 201, domain.Attachment{ID: id, Name: name, ContentType: typ, Size: size})
		return
	}
}

func uploadError(w http.ResponseWriter, err error) {
	var tooBig *http.MaxBytesError
	if errors.Is(err, files.ErrTooLarge) || errors.As(err, &tooBig) {
		fail(w, 413, "too_large", "file is larger than the upload limit")
		return
	}
	fail(w, 400, "bad_request", "could not read the upload")
}

// serveFile returns a stored file. The type comes from the bytes, only a few
// image types are shown inline, and everything else is a download. Nothing
// uploaded is ever served as HTML, SVG or script.
func (a *API) serveFile(w http.ResponseWriter, r *http.Request) {
	// A file named by messages is served only when one of them is in a
	// channel the caller can read. A file no message names yet is the
	// caller's own pending upload (the id is a content hash), so it is served.
	channelIDs, err := a.Store.FileChannels(r.Context(), r.PathValue("id"))
	if err != nil {
		failErr(w, err)
		return
	}
	if len(channelIDs) > 0 {
		ok := false
		for _, id := range channelIDs {
			if a.canSee(r.Context(), current(r).ID, id) {
				ok = true
				break
			}
		}
		if !ok {
			fail(w, 404, "not_found", "file not found")
			return
		}
	}
	f, err := files.Store{Dir: a.FilesDir}.Open(r.PathValue("id"))
	if err != nil {
		if errors.Is(err, files.ErrNotFound) {
			fail(w, 404, "not_found", "file not found")
		} else {
			failErr(w, err)
		}
		return
	}
	defer f.Close()
	fi, err := f.Stat()
	if err != nil {
		failErr(w, err)
		return
	}
	head := make([]byte, 512)
	n, _ := io.ReadFull(f, head)
	if _, err = f.Seek(0, io.SeekStart); err != nil {
		failErr(w, err)
		return
	}
	typ, inline := files.Sniff(head[:n])
	disposition := "attachment"
	if inline {
		disposition = "inline"
	}
	h := w.Header()
	h.Set("Content-Type", typ)
	h.Set("X-Content-Type-Options", "nosniff")
	h.Set("Content-Security-Policy", "default-src 'none'; sandbox")
	h.Set("Cache-Control", servedFileCacheTTL)
	if v := mime.FormatMediaType(disposition, map[string]string{"filename": files.CleanName(r.URL.Query().Get("name"))}); v != "" {
		h.Set("Content-Disposition", v)
	} else {
		h.Set("Content-Disposition", disposition)
	}
	http.ServeContent(w, r, "", fi.ModTime(), f)
}

// attachmentsFor turns the {id, name} pairs of a request into stored
// descriptions. Type and size come from the stored bytes, not the client.
func (a *API) attachmentsFor(in []attachmentIn) ([]domain.Attachment, error) {
	if len(in) == 0 {
		return nil, nil
	}
	if len(in) > maxAttachments || a.FilesDir == "" {
		return nil, errors.New("too many attachments")
	}
	out := make([]domain.Attachment, 0, len(in))
	for _, x := range in {
		typ, size, err := files.Store{Dir: a.FilesDir}.Info(x.ID)
		if err != nil {
			return nil, errors.New("unknown attachment")
		}
		out = append(out, domain.Attachment{ID: x.ID, Name: files.CleanName(x.Name), ContentType: typ, Size: size})
	}
	return out, nil
}

type attachmentIn struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

// visible reports whether the member may read the channel.
func visible(c domain.Channel, memberID string) bool {
	return c.Visibility == domain.VisibilityPublic || slices.Contains(c.MemberIDs, memberID)
}

// search answers GET /api/v1/search?q=&channel_id=&limit=. It only returns
// messages from channels the caller can read.
func (a *API) search(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query().Get("q")
	if len(q) > maxSearchQueryLen {
		fail(w, 400, "bad_request", "query too long")
		return
	}
	channelID := r.URL.Query().Get("channel_id")
	channels, err := a.Store.Channels(r.Context())
	if err != nil {
		failErr(w, err)
		return
	}
	allowed := map[string]bool{}
	for _, c := range channels {
		if visible(c, current(r).ID) {
			allowed[c.ID] = true
		}
	}
	if channelID != "" && !allowed[channelID] {
		fail(w, 404, "not_found", "resource not found")
		return
	}
	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	if limit <= 0 || limit > 100 {
		limit = 30
	}
	// Ask for more than needed, then drop hits from channels the caller cannot read.
	hits, err := a.Store.Search(r.Context(), q, channelID, 100)
	if err != nil {
		failErr(w, err)
		return
	}
	out := make([]domain.SearchHit, 0, limit)
	for _, h := range hits {
		if allowed[h.Message.ChannelID] && len(out) < limit {
			out = append(out, h)
		}
	}
	respond(w, 200, out)
}

func (a *API) pins(w http.ResponseWriter, r *http.Request) {
	c, err := a.Store.Channel(r.Context(), r.PathValue("id"))
	if err != nil || !visible(c, current(r).ID) {
		fail(w, 404, "not_found", "resource not found")
		return
	}
	v, err := a.Store.Pins(r.Context(), c.ID)
	if err != nil {
		failErr(w, err)
		return
	}
	respond(w, 200, v)
}

// setPin pins or unpins a message. Only a human may; repeating the request
// changes nothing and adds no event.
func (a *API) setPin(pin bool) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if current(r).Kind != domain.MemberHuman {
			fail(w, 403, "forbidden", "only a human can pin messages")
			return
		}
		m, err := a.Store.Message(r.Context(), r.PathValue("id"))
		if err != nil {
			failErr(w, err)
			return
		}
		c, err := a.Store.Channel(r.Context(), m.ChannelID)
		if err != nil || !visible(c, current(r).ID) {
			fail(w, 404, "not_found", "resource not found")
			return
		}
		has, err := a.Store.IsPinned(r.Context(), m.ChannelID, m.ID)
		if err != nil {
			failErr(w, err)
			return
		}
		p := domain.Pin{ChannelID: m.ChannelID, MessageID: m.ID, PinnedBy: current(r).ID, PinnedAt: time.Now().UTC()}
		if pin && !has {
			if _, ok := a.append(w, r, events.MessagePinned, m.ChannelID, "", p); !ok {
				return
			}
		}
		if !pin && has {
			if _, ok := a.append(w, r, events.MessageUnpinned, m.ChannelID, "", p); !ok {
				return
			}
		}
		respond(w, 200, map[string]bool{"pinned": pin})
	}
}
