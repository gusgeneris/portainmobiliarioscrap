FROM apify/actor-node-playwright-chrome:20

COPY package*.json ./
RUN npm --quiet set progress=false \
    && npm install --omit=dev --no-optional \
    && npm cache clean --force

COPY . ./

CMD ["npm", "start"]
