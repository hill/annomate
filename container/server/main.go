// texd compiles a LaTeX project with latexmk and returns the PDF, SyncTeX data and log.
//
// Each project keeps a working folder between compiles, so latexmk can reuse its auxiliary
// files and the caller only sends files that changed. The caller sends a manifest of every
// file's hash. A file whose body is not sent must already be here with that hash; otherwise
// the reply is 409 with the missing paths, and the caller sends them.
package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log"
	"mime/multipart"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"syscall"
	"time"
)

const (
	workRoot   = "/work"
	timeout    = 60 * time.Second
	maxUpload  = 200 << 20
	maxPDF     = 50 << 20
	maxLogTail = 1 << 20
)

type request struct {
	Project  string            `json:"project"`
	Main     string            `json:"main"`
	Engine   string            `json:"engine"`
	Manifest map[string]string `json:"manifest"`
}

type result struct {
	OK      bool     `json:"ok"`
	Ms      int64    `json:"ms"`
	Missing []string `json:"missing,omitempty"`
	Error   string   `json:"error,omitempty"`
}

var (
	projectID = regexp.MustCompile(`^[A-Za-z0-9_-]{1,64}$`)
	engines   = map[string]string{"pdflatex": "-pdf", "xelatex": "-xelatex", "lualatex": "-lualatex"}
	locks     sync.Map
)

func main() {
	http.HandleFunc("/ping", func(w http.ResponseWriter, _ *http.Request) { w.Write([]byte("ok")) })
	http.HandleFunc("/compile", compile)
	log.Fatal(http.ListenAndServe(":8080", nil))
}

func compile(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "POST only", http.StatusMethodNotAllowed)
		return
	}
	if err := r.ParseMultipartForm(maxUpload); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	var req request
	if err := json.Unmarshal([]byte(r.FormValue("request")), &req); err != nil {
		http.Error(w, "bad request field", http.StatusBadRequest)
		return
	}
	flag, ok := engines[req.Engine]
	if !ok || !projectID.MatchString(req.Project) || safePath(req.Main) == "" {
		http.Error(w, "bad project, main or engine", http.StatusBadRequest)
		return
	}

	// One compile at a time per project. They share a folder.
	lock, _ := locks.LoadOrStore(req.Project, &sync.Mutex{})
	lock.(*sync.Mutex).Lock()
	defer lock.(*sync.Mutex).Unlock()

	src := filepath.Join(workRoot, req.Project, "src")
	out := filepath.Join(workRoot, req.Project, "out")
	if err := os.MkdirAll(out, 0o755); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	missing, err := sync_(src, req.Manifest, r.MultipartForm.File)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	if len(missing) > 0 {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusConflict)
		json.NewEncoder(w).Encode(result{Missing: missing})
		return
	}

	started := time.Now()
	runErr := latexmk(src, out, req.Main, flag)
	res := result{Ms: time.Since(started).Milliseconds()}
	if runErr != nil {
		res.Error = runErr.Error()
	}

	base := strings.TrimSuffix(filepath.Base(req.Main), filepath.Ext(req.Main))
	pdf, _ := os.ReadFile(filepath.Join(out, base+".pdf"))
	synctex, _ := os.ReadFile(filepath.Join(out, base+".synctex.gz"))
	logText, _ := os.ReadFile(filepath.Join(out, base+".log"))
	if len(logText) > maxLogTail {
		logText = logText[len(logText)-maxLogTail:]
	}
	if len(pdf) > maxPDF {
		pdf = nil
		res.Error = "The PDF is over 50 MB"
	}
	// latexmk exits non-zero on any LaTeX error, though it often still writes a usable PDF.
	res.OK = len(pdf) > 0 && runErr == nil

	body := &bytes.Buffer{}
	mw := multipart.NewWriter(body)
	meta, _ := json.Marshal(res)
	mw.WriteField("result", string(meta))
	mw.WriteField("log", string(logText))
	for name, data := range map[string][]byte{"pdf": pdf, "synctex": synctex} {
		if len(data) == 0 {
			continue
		}
		part, _ := mw.CreateFormFile(name, name)
		part.Write(data)
	}
	mw.Close()
	w.Header().Set("Content-Type", mw.FormDataContentType())
	w.Write(body.Bytes())
}

// sync_ makes `src` hold exactly the manifest's files, writing the uploaded bodies, and
// returns the paths it has no current copy of.
func sync_(src string, manifest map[string]string, uploads map[string][]*multipart.FileHeader) ([]string, error) {
	known := readManifest(src)
	for name, files := range uploads {
		path := safePath(name)
		if path == "" || len(files) == 0 {
			return nil, errors.New("bad upload path " + name)
		}
		f, err := files[0].Open()
		if err != nil {
			return nil, err
		}
		data, err := io.ReadAll(f)
		f.Close()
		if err != nil {
			return nil, err
		}
		full := filepath.Join(src, path)
		if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
			return nil, err
		}
		if err := os.WriteFile(full, data, 0o644); err != nil {
			return nil, err
		}
		known[path] = manifest[path]
	}
	var missing []string
	for name, hash := range manifest {
		path := safePath(name)
		if path == "" {
			return nil, errors.New("bad manifest path " + name)
		}
		if known[path] != hash {
			missing = append(missing, name)
		}
	}
	for path := range known {
		if _, ok := manifest[path]; !ok {
			os.Remove(filepath.Join(src, path))
			delete(known, path)
		}
	}
	writeManifest(src, known)
	return missing, nil
}

func readManifest(src string) map[string]string {
	known := map[string]string{}
	if data, err := os.ReadFile(src + ".manifest.json"); err == nil {
		json.Unmarshal(data, &known)
	}
	return known
}

func writeManifest(src string, known map[string]string) {
	data, _ := json.Marshal(known)
	os.WriteFile(src+".manifest.json", data, 0o644)
}

// safePath cleans a project-relative path, or returns "" for one that escapes the project.
func safePath(p string) string {
	clean := filepath.Clean("/" + p)[1:]
	if clean == "" || strings.HasPrefix(clean, "..") {
		return ""
	}
	return clean
}

// latexmk runs in the main file's folder, as LaTeX resolves paths from there. A timeout kills
// the whole process group, since latexmk starts pdflatex, biber and others as children.
func latexmk(src, out, main, flag string) error {
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	cmd := exec.Command("latexmk", flag, "-synctex=1", "-file-line-error",
		"-interaction=nonstopmode", "-halt-on-error-", "-f", "-outdir="+out, filepath.Base(main))
	cmd.Dir = filepath.Join(src, filepath.Dir(main))
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.Stdout = io.Discard
	cmd.Stderr = io.Discard
	if err := cmd.Start(); err != nil {
		return err
	}
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()
	select {
	case err := <-done:
		return err
	case <-ctx.Done():
		syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
		<-done
		return errors.New("Compiling took over 60 seconds and was stopped")
	}
}
