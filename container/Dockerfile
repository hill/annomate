FROM golang:1.25-alpine AS build
WORKDIR /src
COPY server/ .
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /texd .

# TeX Live's medium scheme plus the collections papers lean on. The full scheme is three times
# the size, which slows pulls and cold starts. Grow this list from "package not installed".
FROM texlive/texlive:latest-medium
RUN tlmgr update --self && tlmgr install \
	collection-latexextra \
	collection-bibtexextra \
	collection-mathscience \
	collection-publishers \
	collection-fontsrecommended \
	biber latexmk \
	&& rm -rf /usr/local/texlive/*/tlpkg/backups/* /root/.texlive*

# No shell escape, and file reads and writes stay inside the project folder.
ENV shell_escape=f openin_any=p openout_any=p
# Long log lines stay whole, so file:line messages are not split at 79 characters.
ENV max_print_line=10000 error_line=254 half_error_line=238
RUN useradd --create-home tex && mkdir /work && chown tex /work
COPY --from=build /texd /usr/local/bin/texd
USER tex
EXPOSE 8080
CMD ["texd"]
