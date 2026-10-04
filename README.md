# BimBot — BİM Aktüel Ürünler YouTube Botu

BİM'in haftalık "Aktüel Ürünler" kataloğunu otomatik olarak çeken, her ürün için Türkçe seslendirme (TTS) ve görsel içeren bir video oluşturan ve sonucu YouTube kanalınıza yükleyen bağımsız bir Node.js botu.

Proje, `n8n_workflow_reference.json` içindeki orijinal n8n workflow'unun Node.js portudur.

## Ne Yapar

1. `https://www.bim.com.tr/aktuel-urunler.aspx` sayfasındaki güncel kataloğu çeker
2. Ürün görsellerini indirir
3. Her ürün için `edge-tts` ile Türkçe seslendirme üretir (fiyatlar Türkçe okunur: "On Bir Bin Dokuz Yüz Lira")
4. FFmpeg ile ürün başına 1920x1080 klip üretir ve hepsini tek videoda birleştirir
5. (İsteğe bağlı) Cloudinary tabanlı özel bir thumbnail oluşturur ve videoya uygular
6. Videoyu YouTube Data API v3 ile kanala yükler
7. Katalog yayın tarihinden 2 gün önce videoyu yayına alır (`isPublishDay` mantığı)
8. Paylaşılan katalogları `processed_dates.json` üzerinden takip ederek tekrar paylaşmayı önler

## Gereksinimler

- **Node.js** v18.0.0 veya üzeri
- **FFmpeg** — PATH'te erişilebilir olmalı (alternatif: `FFMPEG_PATH` ortam değişkeni)
- **Python + edge-tts** — `pip install edge-tts` ile kurulur, PATH'te erişilebilir olmalı (alternatif: `EDGE_TTS_PATH`)
- **Google Cloud Console projesi**:
  1. YouTube Data API v3'ü etkinleştirin
  2. OAuth 2.0 Client ID oluşturun (Desktop app)
  3. `client_secret.json` dosyasını indirip proje kök dizinine koyun

## Yapılandırma

Tüm yol ve hesap ayarları `bim_youtube_bot.js` içindeki `CONFIG` nesnesinde tutulur. Ortam değişkenleri ile override edilebilir. Değişkenleri iki şekilde verebilirsiniz:

1. **`.env` dosyası** — proje kök dizinine `.env.example` dosyasını `.env` olarak kopyalayıp değerlerinizi girin (bot dosyayı otomatik okur; `.env` repo'ya commit edilmez)
2. **Gerçek ortam değişkenleri** — bunlar her zaman `.env` içindeki değerlerden önceliklidir

| Değişken | Varsayılan | Açıklama |
|----------|-----------|----------|
| `FFMPEG_PATH` | `ffmpeg` (PATH) | FFmpeg binary'sinin tam yolu (gerekliyse) |
| `EDGE_TTS_PATH` | `edge-tts` (PATH) | edge-tts binary'sinin tam yolu (gerekliyse) |
| `CLOUDINARY_CLOUD_NAME` | (boş) | Thumbnail overlay'i için Cloudinary hesap adı. Ayarlanmazsa özel thumbnail atlanır, YouTube otomatik kare kullanır |
| `THUMBNAIL_BASE_IMAGE` | `AKTÜEL_KATALOG_m4arhq` | Cloudinary üzerindeki temel thumbnail görseli |

**Not:** Özel thumbnail kullanmak istiyorsanız Cloudinary hesabınızda önceden yüklenmiş bir temel görsel gerekir; `CLOUDINARY_CLOUD_NAME` ve `THUMBNAIL_BASE_IMAGE` değişkenlerini kendi değerlerinizle ayarlayın. `CLOUDINARY_CLOUD_NAME` boş bırakılırsa bot özel thumbnail adımını atlar ve video, YouTube'un otomatik seçtiği kare ile yayınlanır.

**Gizli dosyalar (repo'ya commit edilmez, `.gitignore` içinde):**
- `client_secret.json` — Google OAuth2 kimlik bilgisi
- `youtube_token.json` — Oturum açtıktan sonra otomatik oluşturulan token cache'i
- `processed_dates.json` — İşlenmiş katalogların local kaydı

## Çalıştırma

Manuel:

```bash
npm install
node bim_youtube_bot.js
```

İlk çalıştırmada Google hesabınızla oturum açmanız için terminalde bir link belirir; linke tıklayıp onay kodunu terminale yapıştırın. Token `youtube_token.json` içine kaydedilir, sonraki çalıştırmalarda otomatik yenilenir.

Windows altında günlük otomatik çalıştırma (her gün 21:00'de Görev Zamanlayıcı job'ı oluşturur):

```bash
./schedule_task.bat
```

## Dosya Yapısı

- `bim_youtube_bot.js` — Ana bot kodu (11 adımlı pipeline)
- `n8n_workflow_reference.json` — Orijinal n8n workflow export'u (referans)
- `run_bimbot.bat` — Botu proje dizininden çalıştıran yardımcı script
- `schedule_task.bat` — Windows Görev Zamanlayıcı job kurulumu
- `output/` — Geçici ses, görsel ve video dosyaları (çalışma zamanında oluşur)

## Bilinen Sınırlamalar

- **YouTube kotası:** Günlük upload limiti dolarsa bot hata verir. Retry/backoff mekanizması yoktur.
- **HTML parse:** Katalog sayfası regex ile parse edilir; BİM site yapısını değiştirirse bot kırılır.
- **Yayın zamanlaması:** Video, katalog yayın tarihinden 2 gün önce yüklenir; parse edilemeyen tarihler ("Bayram" vb.) için hemen yayına alınır.
- **SSL:** BİM sitesine yapılan isteklerde sertifika doğrulaması kapalıdır (`rejectUnauthorized: false`).

## Sorun Giderme

- **`ffmpeg` / `edge-tts` bulunamıyor:** İkilisini PATH'e ekleyin ya da `FFMPEG_PATH` / `EDGE_TTS_PATH` ortam değişkenleriyle tam yolu belirtin.
- **`client_secret.json not found`:** Google Cloud Console'dan indirdiğiniz OAuth client dosyasını proje kök dizinine koyun.
- **Özel thumbnail uygulanmıyor:** `CLOUDINARY_CLOUD_NAME` ayarlanmamıştır; bot bu adımı bilinçli olarak atlar.
- **Loglar:** `run_bimbot.bat` kullanıldığında tüm çıktı `output.log` dosyasına yazılır.

## Lisans

MIT — bkz. [LICENSE](LICENSE)

---
Geliştirici: FlowConductor
