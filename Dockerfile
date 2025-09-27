# Используем официальный образ Node.js с Playwright
FROM mcr.microsoft.com/playwright:v1.55.1-jammy

# Устанавливаем рабочую директорию внутри контейнера
WORKDIR /app

# Копируем package.json и package-lock.json
COPY package*.json ./

# Устанавливаем зависимости Node.js
RUN npm install

# Копируем остальной код нашего приложения
COPY . .

# Открываем порт, который слушает наше приложение
EXPOSE 10000

# Команда для запуска нашего сервера
CMD ["node", "server.js"]