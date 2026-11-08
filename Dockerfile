FROM golang:1.26-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/campfire .

FROM alpine:3.22
COPY --from=build /out/campfire /usr/local/bin/campfire
ENV PORT=8080
EXPOSE 8080
USER nobody
CMD ["campfire"]
