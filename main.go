package main

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/PuerkitoBio/goquery"
)

// Konfigurasi
const (
	BaseURL     = "https://x3.sokuja.uk"
	ListURL     = "https://x3.sokuja.uk/anime/list-mode/"
	WorkerCount = 50 
	OutputDir   = "anime_json"
)

// Struktur Data Anime
type Anime struct {
	Title    string    `json:"title"`
	Slug     string    `json:"slug"`
	URL      string    `json:"url"`
	Poster   string    `json:"poster"`
	Synopsis string    `json:"synopsis"`
	Episodes []Episode `json:"episodes"`
}

type Episode struct {
	Episode int               `json:"episode"`
	Title   string            `json:"title"`
	URL     string            `json:"url_page"` // Link Halaman Asli
	Streams map[string]string `json:"streams"`  // Link Video MP4 per Resolusi
}

// Regex untuk mencari Base64 yang potensial berisi link video
var base64Regex = regexp.MustCompile(`[a-zA-Z0-9+/=]{100,}`)
// Regex untuk mencari link mp4 di dalam hasil decode
var mp4Regex = regexp.MustCompile(`https?://[^\s"']+\.mp4`)

func main() {
	if _, err := os.Stat(OutputDir); os.IsNotExist(err) {
		os.Mkdir(OutputDir, 0755)
	}

	fmt.Println("🚀 Memulai Scraper Sokuja (Base64 Hunter Edition)...")

	animeLinks, err := scrapeListMode()
	if err != nil {
		log.Fatalf("❌ Gagal mengambil list anime: %v", err)
	}
	fmt.Printf("✅ Ditemukan %d anime. Memulai %d workers...\n", len(animeLinks), WorkerCount)

	jobs := make(chan string, len(animeLinks))
	results := make(chan string, len(animeLinks))
	var wg sync.WaitGroup

	for w := 1; w <= WorkerCount; w++ {
		wg.Add(1)
		go worker(w, jobs, results, &wg)
	}

	for _, link := range animeLinks {
		jobs <- link
	}
	close(jobs)

	go func() {
		wg.Wait()
		close(results)
	}()

	count := 0
	successCount := 0
	for res := range results {
		count++
		if res == "Success" {
			successCount++
		}
		if count%10 == 0 {
			fmt.Printf("📊 Progress: %d/%d (Sukses: %d)\n", count, len(animeLinks), successCount)
		}
	}

	fmt.Println("🎉 Selesai! Cek folder:", OutputDir)
}

func worker(id int, jobs <-chan string, results chan<- string, wg *sync.WaitGroup) {
	defer wg.Done()
	for url := range jobs {
		err := scrapeAnimeDetail(url)
		if err != nil {
			results <- "Failed"
		} else {
			results <- "Success"
		}
	}
}

func scrapeListMode() ([]string, error) {
	doc, err := fetchHTML(ListURL)
	if err != nil {
		return nil, err
	}

	var links []string
	doc.Find(".soralist a.series").Each(func(i int, s *goquery.Selection) {
		href, exists := s.Attr("href")
		if exists {
			links = append(links, href)
		}
	})
	return links, nil
}

func scrapeAnimeDetail(url string) error {
	doc, err := fetchHTML(url)
	if err != nil {
		return err
	}

	title := strings.TrimSpace(doc.Find("h1.entry-title").Text())
	poster, _ := doc.Find(".thumb img").Attr("src")
	synopsis := strings.TrimSpace(doc.Find(".entry-content p").Text())
	slug := getSlug(url)

	var episodes []Episode
	
	// Kita kumpulkan dulu semua URL episode untuk diproses paralel juga (sub-worker) atau serial (kalau mau simple)
	// Karena ini di dalam worker utama, kita proses serial saja per anime agar tidak membebani network terlalu parah
	
doc.Find(".eplister ul li").Each(func(i int, s *goquery.Selection) {
		link := s.Find("a")
		epURL, _ := link.Attr("href")
		epTitle := strings.TrimSpace(s.Find(".epl-title").Text())
		epNumStr := strings.TrimSpace(s.Find(".epl-num").Text())
		
		epNum, _ := strconv.Atoi(epNumStr)
		if epNum == 0 {
			epNum = i + 1 
		}

		// HUNTING LINK VIDEO (Base64)
		streamLinks := huntVideoLinks(epURL)

		episodes = append(episodes, Episode{
			Episode: epNum,
			Title:   epTitle,
			URL:     epURL,
			Streams: streamLinks,
		})
	})

	sort.Slice(episodes, func(i, j int) bool {
		return episodes[i].Episode < episodes[j].Episode
	})

	animeData := Anime{
		Title:    title,
		Slug:     slug,
		URL:      url,
		Poster:   poster,
		Synopsis: synopsis,
		Episodes: episodes,
	}

	filename := filepath.Join(OutputDir, slug+".json")
	file, err := os.Create(filename)
	if err != nil {
		return err
	}
	defer file.Close()

	encoder := json.NewEncoder(file)
	encoder.SetIndent("", "  ")
	return encoder.Encode(animeData)
}

// Fungsi Utama Pemburu Base64
func huntVideoLinks(epURL string) map[string]string {
	streams := make(map[string]string)
	
	// Kita harus fetch HTML mentah (sebagai string) untuk Regex
	resp, err := fetchRawHTML(epURL)
	if err != nil {
		return streams
	}

	// Cari semua string Base64 yang panjang
	matches := base64Regex.FindAllString(resp, -1)
	
	for _, encoded := range matches {
		decodedBytes, err := base64.StdEncoding.DecodeString(encoded)
		if err != nil {
			continue
		}
		decodedStr := string(decodedBytes)

		// Cari link MP4 di hasil decode
		mp4Links := mp4Regex.FindAllString(decodedStr, -1)
		for _, link := range mp4Links {
			// Deteksi Resolusi dari nama file
			res := "unknown"
			if strings.Contains(link, "360p") {
				res = "360p"
			} else if strings.Contains(link, "480p") {
				res = "480p"
			} else if strings.Contains(link, "720p") {
				res = "720p"
			} else if strings.Contains(link, "1080p") {
				res = "1080p"
			}

			// Simpan link (prioritaskan nontony atau direct link)
			// Kalau resolusi sama, timpa saja (biasanya yang terakhir ditemukan lebih relevan atau kita bisa cek domain)
			if !strings.Contains(link, "web.archive.org") { // Hindari link mati Wayback Machine
				streams[res] = link
			}
		}
	}
	return streams
}

func fetchRawHTML(url string) (string, error) {
	client := &http.Client{Timeout: 15 * time.Second}
	req, _ := http.NewRequest("GET", url, nil)
	req.Header.Set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36")
	
	res, err := client.Do(req)
	if err != nil {
		return "", err
	}
	defer res.Body.Close()
	
	bodyBytes, err := io.ReadAll(res.Body)
	if err != nil {
		return "", err
	}
	return string(bodyBytes), nil
}

func fetchHTML(url string) (*goquery.Document, error) {
	client := &http.Client{Timeout: 30 * time.Second}
	req, _ := http.NewRequest("GET", url, nil)
	req.Header.Set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36")

	res, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()

	if res.StatusCode != 200 {
		return nil, fmt.Errorf("status code error: %d %s", res.StatusCode, res.Status)
	}

	return goquery.NewDocumentFromReader(res.Body)
}

func getSlug(url string) string {
	parts := strings.Split(strings.TrimRight(url, "/"), "/")
	if len(parts) > 0 {
		return parts[len(parts)-1]
	}
	return "unknown"
}